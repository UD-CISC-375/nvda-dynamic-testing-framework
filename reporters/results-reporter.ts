// Copilot was used for the following code. All code was human approved and passed all tests

import type {
  FullConfig, FullResult, Reporter, TestCase, TestResult,
} from "@playwright/test/reporter";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AxeViolation, Results, ScenarioResult, StateResult, TreeDiff,
} from "../results/schema";

// Fixed output location. The reporter writes here after every run so
// downstream consumers always know where to look.
const OUT_DIR = path.join("results", "output");

// Placeholder for "no tree changes". Used until Team X's tree-diff branches
// add a dom-changes.json attachment.
const emptyDiff = (): TreeDiff => ({ added: [], removed: [], changed: [], reordered: [] });

// Reads an attachment's JSON. Playwright gives either an in-memory `body`
// or a file `path`, so both are handled. A malformed or unreadable
// attachment is logged and skipped (returns undefined). 
function readAttachment(
  attachments: TestResult["attachments"], name: string,
): any | undefined {
  const att = attachments.find((a) => a.name === name);
  if (!att) return undefined;
  try {
    const text = att.body ? att.body.toString("utf8") : readFileSync(att.path!, "utf8");
    return JSON.parse(text);
  } catch (err) {
    console.warn(`[results-reporter] skipping malformed attachment "${name}": ${err}`);
    return undefined;
  }
}

// Flattens raw axe output  into one 
// entry per affected element, which is what the schema's AxeViolation uses.
const toViolations = (axe: any): AxeViolation[] =>
  (axe?.violations ?? []).flatMap((v: any) =>
    (v.nodes ?? []).map((n: any) => ({ rule: v.id, target: n.target ?? [] })));

// Same-rule + same-selector identity, matching diffViolations in tests/helpers/axe.ts.
const keyOf = (v: AxeViolation) => `${v.rule} ${JSON.stringify(v.target)}`;

class ResultsReporter implements Reporter {
  private config!: FullConfig;
  // Keyed by test id so a retried test is recorded once 
  private scenarios = new Map<string, ScenarioResult>();

  onBegin(config: FullConfig) { this.config = config; }

  // Runs after each test: builds the two-state (before/after) view from
  // that test's axe-before.json / axe-after.json / dom-changes.json
  // attachments. Missing attachments are fine; the test still appears.
  onTestEnd(test: TestCase, result: TestResult) {
    try {
      const before = readAttachment(result.attachments, "axe-before.json");
      const after = readAttachment(result.attachments, "axe-after.json");
      const dom = readAttachment(result.attachments, "dom-changes.json");

      const states: StateResult[] = [];
      if (before) {
        const b = toViolations(before);
        states.push({
          index: 0, trigger: "Page loaded",
          domChangeSummary: "Baseline; no previous state.",
          treeDiff: emptyDiff(),
          axe: { new: b, resolved: [], totalCount: b.length },
          stable: true,
        });
        if (after) {
          const a = toViolations(after);
          const bKeys = new Set(b.map(keyOf));
          const aKeys = new Set(a.map(keyOf));
          states.push({
            index: 1, trigger: "After the interaction",
            domChangeSummary: dom?.summary ?? "No DOM change data recorded.",
            treeDiff: dom?.treeDiff ?? emptyDiff(),
            axe: {
              new: a.filter((v) => !bKeys.has(keyOf(v))),
              resolved: b.filter((v) => !aKeys.has(keyOf(v))),
              totalCount: a.length,
            },
            stable: true,
          });
        }
      }

      const base = {
        // "tests/menu.spec.ts" -> "menu"; variant comes from the test title.
        scenario: path.basename(test.location.file).replace(/\.spec\.\w+$/, ""),
        variant: test.title.match(/accessible|broken/)?.[0] ?? "n/a",
        states,
      };
      this.scenarios.set(test.id,
        result.status === "skipped"
          ? { ...base, verdict: "skipped",
              skippedReason: test.annotations.find((a) => a.type === "skip")?.description
                ?? "No reason given" }
          : { ...base, verdict: result.status === "passed" ? "passed" : "failed" });
    } catch (err) {
      console.warn(`[results-reporter] could not process "${test.title}": ${err}`);
    }
  }

  // Writes results.json once the whole run finishes. Wrapped in try/catch so
  // a write problem is logged instead of failing the run.
  onEnd(_result: FullResult) {
    try {
      let commit = "unknown";
      try { commit = execSync("git rev-parse HEAD").toString().trim(); } catch {}
      const out: Results = {
        schemaVersion: 0,
        run: {
          timestamp: new Date().toISOString(),
          commit,
          siteUrl: this.config.projects[0]?.use.baseURL ?? "",
          scenarios: [...this.scenarios.values()],
        },
      };
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(out, null, 2));
    } catch (err) {
      console.warn(`[results-reporter] could not write results.json: ${err}`);
    }
  }
}

export default ResultsReporter;
