// Type-only, so this module loads nothing at runtime (the reporter imports it).
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
// Exported for axe.ts only; axe.ts doesn't re-export it.
export const SCAN_TAGS = [...WCAG_TAGS, "best-practice"];

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
