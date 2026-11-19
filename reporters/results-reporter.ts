import type { AxeResults } from "axe-core";
import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AxeViolation,
  Results,
  ScenarioResult,
  StateResult,
} from "../results/schema";

const OUT_DIR = path.join("results", "output");

type AxeNode = Omit<
  Pick<
    AxeResults["violations"][number]["nodes"][number],
    "target" | "html" | "failureSummary"
  >,
  "failureSummary"
> & { failureSummary: string; impact?: string };

type AxeRule = Pick<
  AxeResults["violations"][number],
  "id" | "help" | "helpUrl"
> & { impact?: string; nodes: AxeNode[] };

type AxeScan = { violations: AxeRule[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAttachment(
  attachments: TestResult["attachments"],
  name: string,
): unknown | undefined {
  const attachment = attachments.find((item) => item.name === name);
  if (!attachment) return undefined;

  const text = attachment.body
    ? attachment.body.toString("utf8")
    : attachment.path
      ? readFileSync(attachment.path, "utf8")
      : undefined;
  if (text === undefined) {
    throw new Error(`Attachment "${name}" has no readable body or path`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse attachment "${name}" as JSON`,
      { cause: error },
    );
  }
}

function isAxeScan(value: unknown): value is AxeScan {
  if (!isRecord(value) || !Array.isArray(value.violations)) return false;
  return value.violations.every((rule) => {
    if (
      !isRecord(rule) ||
      typeof rule.id !== "string" ||
      typeof rule.help !== "string" ||
      typeof rule.helpUrl !== "string" ||
      !rule.helpUrl.startsWith("https://") ||
      (rule.impact !== undefined && typeof rule.impact !== "string") ||
      !Array.isArray(rule.nodes)
    ) {
      return false;
    }

    return rule.nodes.every(
      (node) =>
        isRecord(node) &&
        Array.isArray(node.target) &&
        node.target.every((part) => typeof part === "string") &&
        typeof node.html === "string" &&
        typeof node.failureSummary === "string" &&
        (node.impact === undefined || typeof node.impact === "string"),
    );
  });
}

function toViolations(value: unknown, attachmentName: string): AxeViolation[] {
  if (!isAxeScan(value)) {
    throw new Error(`Attachment "${attachmentName}" is not a valid axe scan`);
  }

  return value.violations.flatMap((rule) =>
    rule.nodes.map((node) => ({
      rule: rule.id,
      target: node.target,
      impact: node.impact ?? rule.impact,
      help: rule.help,
      helpUrl: rule.helpUrl,
      failureSummary: node.failureSummary,
      html: node.html,
    })),
  );
}

function isScenarioResult(value: unknown): value is ScenarioResult {
  if (
    !isRecord(value) ||
    typeof value.scenario !== "string" ||
    typeof value.variant !== "string" ||
    !["passed", "failed", "skipped"].includes(String(value.verdict)) ||
    !Array.isArray(value.states)
  ) {
    return false;
  }

  return value.states.every(
    (state) =>
      isRecord(state) &&
      Number.isInteger(state.index) &&
      typeof state.trigger === "string" &&
      typeof state.domChangeSummary === "string" &&
      isRecord(state.treeDiff) &&
      isRecord(state.axe) &&
      Array.isArray(state.axe.new) &&
      Array.isArray(state.axe.resolved) &&
      Number.isInteger(state.axe.totalCount) &&
      (typeof state.stable === "boolean" || state.stable === null),
  );
}

function findingKey(finding: AxeViolation): string {
  return `${finding.rule} ${JSON.stringify(finding.target)}`;
}

function mergeAxeScans(
  result: ScenarioResult,
  before: AxeViolation[],
  after: AxeViolation[],
): ScenarioResult {
  if (result.states.length !== 2) {
    throw new Error(
      `Scenario "${result.scenario}:${result.variant}" must record baseline and after states`,
    );
  }

  const beforeState: StateResult = {
    ...result.states[0],
    axe: {
      new: before,
      resolved: [],
      totalCount: before.length,
    },
  };
  const beforeKeys = new Set(before.map(findingKey));
  const afterKeys = new Set(after.map(findingKey));
  const afterState: StateResult = {
    ...result.states[1],
    axe: {
      new: after.filter((finding) => !beforeKeys.has(findingKey(finding))),
      resolved: before.filter((finding) => !afterKeys.has(findingKey(finding))),
      totalCount: after.length,
    },
  };

  return { ...result, states: [beforeState, afterState] };
}

export default class ResultsReporter implements Reporter {
  private config!: FullConfig;
  private readonly scenarios = new Map<string, ScenarioResult>();

  onBegin(config: FullConfig): void {
    this.config = config;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const marker = test.annotations.find(
      (annotation) => annotation.type === "accessibility-scenario",
    );
    if (!marker?.description) return;

    const [markerScenario, markerVariant] = marker.description.split(":");
    const payload = readAttachment(
      result.attachments,
      "accessibility-scenario.json",
    );
    if (payload === undefined) {
      this.scenarios.set(test.id, {
        scenario: markerScenario || "unknown",
        variant: markerVariant || "unknown",
        verdict: "skipped",
        skippedReason: `No accessibility result was recorded; test status: ${result.status}.`,
        states: [],
      });
      return;
    }
    if (!isScenarioResult(payload)) {
      throw new Error(
        `Test "${test.title}" attached an invalid accessibility scenario result`,
      );
    }
    if (markerVariant && payload.variant !== markerVariant) {
      throw new Error(
        `Test "${test.title}" recorded variant "${payload.variant}" but was marked "${markerVariant}"`,
      );
    }

    const [beforeScan, afterScan] = [
      readAttachment(result.attachments, "axe-before.json"),
      readAttachment(result.attachments, "axe-after.json"),
    ];
    if (beforeScan === undefined || afterScan === undefined) {
      throw new Error(
        `Test "${test.title}" must attach axe-before.json and axe-after.json`,
      );
    }

    const merged = mergeAxeScans(
      payload,
      toViolations(beforeScan, "axe-before.json"),
      toViolations(afterScan, "axe-after.json"),
    );
    if (result.status !== test.expectedStatus) {
      merged.executionNote = `The test ended with status ${result.status}; expected ${test.expectedStatus}.`;
    }
    this.scenarios.set(test.id, merged);
  }

  onEnd(): void {
    const results: Results = {
      schemaVersion: 0,
      run: {
        timestamp: new Date().toISOString(),
        commit:
          process.env.GITHUB_SHA ??
          execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        siteUrl: String(
          this.config.projects.find((project) => project.name === "chromium")
            ?.use.baseURL ?? "",
        ),
        scope:
          "Only tests annotated to record accessibility results are included. Currently this report covers the menu scenario; other scenarios are not assessed here.",
        scenarios: [...this.scenarios.values()].sort((a, b) =>
          `${a.scenario}:${a.variant}`.localeCompare(
            `${b.scenario}:${b.variant}`,
          ),
        ),
      },
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      path.join(OUT_DIR, "results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
      "utf8",
    );
    console.log(`Wrote accessibility results to ${path.join(OUT_DIR, "results.json")}`);
  }
}
