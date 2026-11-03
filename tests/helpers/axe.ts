import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import type { Result } from "axe-core";

// Only run the rules that map to WCAG 2.0/2.1/2.2 levels A and AA.
// A: WCAG minimum baseline
// AA: WCAG Standard Benchmark

const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

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
