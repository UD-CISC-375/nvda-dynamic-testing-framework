import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import type { Results, ScenarioResult } from "../../results/schema";

export default class ResultsReporter implements Reporter {
  private readonly scenarios = new Map<string, ScenarioResult>();
  private siteUrl = "";

  onBegin(config: FullConfig): void {
    this.siteUrl = String(config.projects.find((project) => project.name === "chromium")?.use.baseURL ?? "");
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const marker = test.annotations.find((annotation) => annotation.type === "accessibility-scenario");
    if (!marker?.description) return;
    const [scenario, variant] = marker.description.split(":");
    if (!scenario || !variant) throw new Error(`Invalid accessibility-scenario annotation: ${marker.description}`);

    const attachment = result.attachments.find((item) => item.name === "accessibility-scenario.json");
    if (!attachment) {
      // A test that cannot record its states must never appear as an accessible result.
      this.scenarios.set(marker.description, {
        scenario,
        variant,
        verdict: "skipped",
        skippedReason: `No result was recorded; the test ended with status ${result.status}.`,
        states: [],
      });
      return;
    }

    const data = attachment.body ?? (attachment.path ? await readFile(attachment.path) : undefined);
    if (!data) throw new Error(`Empty result attachment for ${marker.description}`);
    const captured: ScenarioResult = JSON.parse(data.toString());
    if (captured.scenario !== scenario || captured.variant !== variant) {
      throw new Error(`Result attachment does not match ${marker.description}`);
    }
    if (result.status !== test.expectedStatus) {
      captured.executionNote = `The test ended with status ${result.status}; expected ${test.expectedStatus}.`;
    }
    this.scenarios.set(marker.description, captured);
  }

  async onEnd(): Promise<void> {
    const output = process.env.ACCESSIBILITY_RESULTS_PATH;
    if (!output) throw new Error("ACCESSIBILITY_RESULTS_PATH must identify the results file");
    if (this.scenarios.size === 0) throw new Error("No tests recorded accessibility scenarios");
    const results: Results = {
      schemaVersion: 0,
      run: {
        timestamp: new Date().toISOString(),
        commit: process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        siteUrl: this.siteUrl,
        scope: "Only tests instrumented to record structured results are included. Currently this report covers the menu scenario; other scenarios are not assessed here.",
        scenarios: [...this.scenarios.values()].sort((a, b) =>
          `${a.scenario}:${a.variant}`.localeCompare(`${b.scenario}:${b.variant}`),
        ),
      },
    };
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(results, null, 2) + "\n", "utf8");
    console.log(`Wrote accessibility results to ${path}`);
  }
}
