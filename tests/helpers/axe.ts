import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import type { Result } from "axe-core";

// The repo's one axe policy: every scan runs WCAG + best-practice rules, WCAG
// violations fail a test, and best-practice violations are only warnings.
// Specs don't choose tags.
// A: WCAG minimum baseline
// AA: WCAG Standard Benchmark

// The rules that fail a test: WCAG 2.0/2.1/2.2 levels A and AA.
export const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

// What every scan runs: WCAG plus axe's best-practice rules, which catch flaws
// axe doesn't tag as WCAG (e.g. `aria-dialog-name` on the broken dialog).
const SCAN_TAGS = [...WCAG_TAGS, "best-practice"];

/**
 * True when a violated rule maps to WCAG A/AA, so it should fail a test.
 * Anything else the scan finds (in practice, best-practice rules) is a warning.
 * A rule tagged both WCAG and best-practice counts as WCAG.
 */
export function isWcagViolation(violation: Pick<Result, "tags">) {
  return violation.tags.some((tag) => WCAG_TAGS.includes(tag));
}

/**
 * Splits one scan's violations into failures (WCAG) and warnings (the rest),
 * keeping axe's order inside each list.
 */
export function splitViolations(violations: Result[]) {
  return {
    failures: violations.filter(isWcagViolation),
    warnings: violations.filter((v) => !isWcagViolation(v)),
  };
}

/**
 * Runs axe against the page as it is *right now* and returns
 * `{ failures, warnings }`. Use it when a spec needs to assert on a
 * best-practice finding (e.g. the broken dialog's `aria-dialog-name`);
 * otherwise use runAxe.
 * `label` (e.g. "before" / "after") names the report attachment so we can
 * tell scans of the same page apart.
 */
export async function scanAxe(page: Page, testInfo: TestInfo, label: string) {
  // One scan covers both lists; the split happens afterwards, by tag.
  const results = await new AxeBuilder({ page }).withTags(SCAN_TAGS).analyze();
  const { failures, warnings } = splitViolations(results.violations);

  // Short summary in the terminal: one line per broken rule, warnings marked.
  console.log(
    `[axe ${label}] ${failures.length} violation(s), ${warnings.length} warning(s)`,
  );
  for (const v of results.violations) {
    const kind = isWcagViolation(v) ? "-" : "- [warn]";
    console.log(
      `  ${kind} ${v.id} (${v.impact}): ${v.nodes.length} element(s) - ${v.help}`,
    );
  }

  // Full results, warnings included, go into the HTML report (npx playwright show-report).
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });

  return { failures, warnings };
}

/**
 * Runs the same scan as scanAxe and returns only the WCAG failures, which is
 * what a test should fail on. Best-practice warnings are logged and attached
 * but not returned.
 */
export async function runAxe(page: Page, testInfo: TestInfo, label: string) {
  return (await scanAxe(page, testInfo, label)).failures;
}

/**
 * Returns the problems in `after` that were NOT already in `before`.
 * Compares rule + element, so if a button was failing for a missing label
 * before, and a new button appears with a missing label, only the new
 * button is returned. (The after scan itself still lists both.)
 * "Same element" means same CSS selector from axe, so an old element whose
 * selector changes (e.g. it shifted position) can show up as new.
 */

export function diffViolations(before: Result[], after: Result[]) {
  // node.target is the CSS selector axe uses to point at the element.
  const key = (ruleId: string, target: unknown) =>
    `${ruleId} ${JSON.stringify(target)}`;

  const seenBefore = new Set(
    before.flatMap((v) => v.nodes.map((node) => key(v.id, node.target))),
  );

  return after.flatMap((v) =>
    v.nodes
      .filter((node) => !seenBefore.has(key(v.id, node.target)))
      .map((node) => ({ rule: v.id, element: node.target.join(" ") })),
  );
}
