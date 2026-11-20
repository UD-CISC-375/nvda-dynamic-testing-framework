// Browser-free unit tests for the axe fail/warn split (no page is opened in this file).
import { test, expect } from "@playwright/test";
import type { Result } from "axe-core";
import { isWcagViolation, splitViolations } from "./helpers/axe-policy";

// A hand-built violation with only the fields the split reads; the cast lets us skip the rest.
const violation = (id: string, tags: string[]) => ({ id, tags, nodes: [] }) as unknown as Result;

// Tags taken from axe-core 4.13's rules (trimmed to the ones that matter here).
const buttonName = violation("button-name", ["cat.name-role-value", "wcag2a", "wcag412", "section508"]);
const dialogName = violation("aria-dialog-name", ["cat.aria", "best-practice"]);
const region = violation("region", ["cat.keyboard", "best-practice"]);

test("a rule with any WCAG A/AA tag is a failure", () => {
  expect(isWcagViolation(buttonName)).toBe(true);
});

test("a best-practice-only rule is a warning", () => {
  expect(isWcagViolation(dialogName)).toBe(false);
});

// No axe 4.13 rule has both, but a future version could; WCAG should win.
test("a rule tagged both WCAG and best-practice counts as a failure", () => {
  expect(isWcagViolation(violation("both", ["wcag2aa", "best-practice"]))).toBe(true);
});

test("WCAG AAA and other non-A/AA tags are warnings", () => {
  // wcag2aaa is not in WCAG_TAGS, so axe's AAA rules never fail a test.
  expect(isWcagViolation(violation("aaa", ["wcag2aaa", "wcag146"]))).toBe(false);
});

test("splitViolations keeps axe's order inside each list", () => {
  expect(splitViolations([dialogName, buttonName, region])).toEqual({
    failures: [buttonName],
    warnings: [dialogName, region],
  });
});

test("splitViolations of a clean scan is two empty lists", () => {
  expect(splitViolations([])).toEqual({ failures: [], warnings: [] });
});
