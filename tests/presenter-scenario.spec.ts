// Demo-only: runs one Team Y scenario through the tree tracker (#130) for the presenter page
// (presenter/server.mjs). Picks the scenario from the SCENARIO env var; skipped without it.
import { test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { createTreeTracker } from "./helpers/tree-tracker";
import type { TreeEntry, TreeTracker } from "./helpers/tree-tracker";
import { runAxe } from "./helpers/axe";

// The scenario to run, by id in Team Y's scenarios.json.
const SCENARIO = process.env.SCENARIO;

// npm test never sets SCENARIO, so these tests stay out of the normal suite.
test.skip(!SCENARIO, "presenter only: set SCENARIO=<id> to run");

// Slow scenarios wait seconds per step, and slowMo adds 500 ms per action.
test.setTimeout(120_000);

// One scenario from the manifest, with only the fields used here.
type Step = { action: string; testid: string; value?: string };
type Scenario = {
  id: string;
  path: string;
  title: string;
  defaultDelay: number;
  setup: Step[];
  axe: { brokenRules: string[]; nvdaOnly: boolean };
};

// Scenarios with no setup get a step here, so there's something to show.
const EXTRA_STEPS: Record<string, Step[]> = {
  "disclosure-tabs": [{ action: "click", testid: "tab-security" }],
  "forms-labels": [{ action: "fill", testid: "full-name", value: "Ann" }],
};

// The two timeout messages next() throws when nothing more happens.
const DONE = /no new entry|no settled change/;

// One violation, reduced to what the page shows.
type AxeSummary = { id: string; impact: string | null | undefined; help: string; nodes: number };

// An entry without its tree (too big for the page), plus the scan of its state.
function trim(entry: TreeEntry, axe?: AxeSummary[]) {
  return {
    index: entry.index,
    stateIndex: entry.stateIndex,
    newState: entry.newState,
    meaningful: entry.meaningful,
    timestamp: entry.timestamp,
    diff: entry.diff,
    focusChanges: entry.focusChanges,
    classification: {
      changes: entry.classification.changes.map(({ reason, label, provisional, change }) => ({
        reason,
        label,
        ...(provisional && { provisional }),
        change,
      })),
    },
    ...(axe && { axe }),
  };
}

// Scan a new state with axe and keep a one-line summary per rule.
async function scan(page: Page, testInfo: TestInfo, entry: TreeEntry): Promise<AxeSummary[] | undefined> {
  // Recorded entries belong to a state that was already scanned.
  if (!entry.newState) return undefined;
  const violations = await runAxe(page, testInfo, `state-${entry.stateIndex}`);
  return violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
}

// Collect every entry until the tracker times out. One action can make several entries (focus
// first, content later), so keep asking until nothing more settles.
async function drain(page: Page, testInfo: TestInfo, tracker: TreeTracker, timeoutMs: number) {
  const entries: ReturnType<typeof trim>[] = [];
  for (;;) {
    let entry: TreeEntry;
    try {
      entry = await tracker.next({ timeoutMs });
    } catch (e) {
      // A timeout means the page is done; anything else is a real failure.
      if (e instanceof Error && DONE.test(e.message)) return entries;
      throw e;
    }
    // Scan right away, while the page is still in the state the entry describes.
    entries.push(trim(entry, await scan(page, testInfo, entry)));
  }
}

// Run one step the way a user would. fill/press/focus() would move focus from script, which
// the tracker reads as the page moving focus, so everything starts with a real click.
async function runStep(page: Page, step: Step) {
  const target = page.getByTestId(step.testid);
  if (step.action === "click") await target.click();
  else if (step.action === "fill") {
    await target.click();
    await page.keyboard.type(step.value ?? "");
  } else if (step.action === "press") {
    await target.click();
    await page.keyboard.press(step.value ?? "");
  } else throw new Error(`presenter: unknown step action "${step.action}"`);
}

for (const variant of ["accessible", "broken"] as const) {
  test(`${variant}: ${SCENARIO}`, async ({ page, baseURL }, testInfo) => {
    // Filled in as the run goes, so a failure still attaches what it got.
    const result: { scenario?: object; steps: { label: string; entries: unknown[] }[]; error?: string } = { steps: [] };
    try {
      // Team Y's manifest, built from registry.data.ts.
      const manifest = await (await fetch(new URL("scenarios.json", baseURL))).json();
      const scenario: Scenario | undefined = manifest.scenarios.find((s: Scenario) => s.id === SCENARIO);
      if (!scenario) throw new Error(`presenter: no scenario "${SCENARIO}" in scenarios.json`);
      const { id, title, path, axe } = scenario;
      result.scenario = { id, title, path, variant, brokenRules: axe.brokenRules, nvdaOnly: axe.nvdaOnly };

      // Long enough for the slow scenarios' second entry (loading and delayed content: 2000 ms).
      const timeoutMs = scenario.defaultDelay + 2000;

      await page.goto(`#${path}?variant=${variant}`);
      await page.waitForLoadState("networkidle");
      const tracker = await createTreeTracker(page, page.locator("body"));

      // The baseline is state 0, so it gets scanned too.
      const baseline = tracker.history()[0];
      result.steps.push({ label: "baseline", entries: [trim(baseline, await scan(page, testInfo, baseline))] });
      // Changes with no user action, e.g. delayed content.
      result.steps.push({ label: "no action", entries: await drain(page, testInfo, tracker, timeoutMs) });

      // waitFor steps are dropped: the tracker waits for settling itself.
      const steps = [...scenario.setup.filter((s) => s.action !== "waitFor"), ...(EXTRA_STEPS[id] ?? [])];
      for (const step of steps) {
        await runStep(page, step);
        result.steps.push({ label: `${step.action} ${step.testid}`, entries: await drain(page, testInfo, tracker, timeoutMs) });
      }
    } catch (e) {
      // Keep the message for the page, then fail the test.
      result.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      await testInfo.attach(`presenter-${variant}.json`, {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
    }
  });
}
