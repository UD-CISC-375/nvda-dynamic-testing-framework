import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import type { Result } from "axe-core";

// The repo's one axe tag policy. Specs import these instead of writing their own lists.
// A: WCAG minimum baseline
// AA: WCAG Standard Benchmark

// Default: only the rules that map to WCAG 2.0/2.1/2.2 levels A and AA.
export const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

// Opt-in: WCAG plus axe's best-practice rules, for flaws axe only tags as
// best-practice (e.g. `aria-dialog-name` on the broken dialog).
export const BEST_PRACTICE_TAGS = [...WCAG_TAGS, "best-practice"];

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
 * Scans with WCAG + best-practice and returns `{ failures, warnings }`.
 * For specs that need to see best-practice findings (e.g. the broken dialog's
 * `aria-dialog-name`); everything else should use runAxe.
 */
export async function scanAxe(page: Page, testInfo: TestInfo, label: string) {
  // One scan covers both lists; the split happens afterwards, by tag.
  return splitViolations(await scan(page, testInfo, label, BEST_PRACTICE_TAGS));
}

/**
 * Runs axe against the page as it is *right now* and returns the violations.
 * `label` (e.g. "before" / "after") names the report attachment so we can
 * tell scans of the same page apart.
 */
export async function runAxe(
  page: Page,
  testInfo: TestInfo,
  label: string,
  tags: string[] = WCAG_TAGS,
) {
  return scan(page, testInfo, label, tags);
}

// Shared by runAxe and scanAxe: scan, log a summary, attach the raw results.
async function scan(
  page: Page,
  testInfo: TestInfo,
  label: string,
  tags: string[],
) {
  const results = await new AxeBuilder({ page }).withTags(tags).analyze();

  // Short summary in the terminal: one line per broken rule.
  console.log(`[axe ${label}] ${results.violations.length} violation(s)`);
  for (const v of results.violations) {
    console.log(
      `  - ${v.id} (${v.impact}): ${v.nodes.length} element(s) - ${v.help}`,
    );
  }

  // Full results go into the HTML report (npx playwright show-report).
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });

  return results.violations;
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
