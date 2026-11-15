// Import Playwright's test runner, assertion library, and the TestInfo type (for the fake).
import { test, expect, TestInfo } from "@playwright/test";
// Import the helper under test.
import { trigger } from "./helpers/trigger";

// A page with a trigger button that records every click and Enter press.
const triggerPage = `
  <button data-testid="trigger">Go</button>
  <ol id="log"></ol>
  <script>
    // Append one line per event so tests can count exactly what happened.
    const log = (text) => {
      const li = document.createElement("li");
      li.textContent = text;
      document.getElementById("log").appendChild(li);
    };
    // A click (including one from Enter on a button) logs "click".
    document.querySelector("button").addEventListener("click", () => log("click"));
  </script>
`;

// Build the two TestInfo fields the helper reads, for either project.
const fakeInfo = (name: string, timeout = 1234) =>
  ({ project: { name }, timeout }) as Pick<TestInfo, "project" | "timeout">;

// With no auto option, automated projects click data-testid="trigger".
test("trigger clicks the trigger button by default", async ({ page }) => {
  // Load the inline page (no network needed).
  await page.setContent(triggerPage);
  // humanDone must not run outside the manual project, so make it fail loudly.
  await trigger(page, fakeInfo("chromium"), {
    prompt: "unused",
    humanDone: async () => {
      throw new Error("humanDone called in an automated project");
    },
  });
  // Exactly one click reached the button.
  await expect(page.locator("#log li")).toHaveText(["click"]);
});

// A custom auto replaces the default click entirely (dialog uses focus + Enter).
test("trigger runs a custom auto action instead of clicking", async ({ page }) => {
  // Load the inline page.
  await page.setContent(triggerPage);
  // Record whether the custom action ran.
  let ran = false;
  await trigger(page, fakeInfo("chromium"), {
    prompt: "unused",
    humanDone: async () => {},
    auto: async () => {
      ran = true;
    },
  });
  // The custom action ran, and the default click did not.
  expect(ran).toBe(true);
  await expect(page.locator("#log li")).toHaveCount(0);
});

// In the manual project the helper waits for the person and never acts itself.
test("trigger in manual mode waits with testInfo.timeout and does not click", async ({ page }) => {
  // Load the inline page.
  await page.setContent(triggerPage);
  // Capture the timeout the helper hands to humanDone.
  let passed: number | undefined;
  await trigger(page, fakeInfo("manual", 4321), {
    prompt: ">>> test prompt <<<",
    humanDone: async (timeout) => {
      passed = timeout;
    },
  });
  // The wait used the project's test timeout, not a hardcoded value.
  expect(passed).toBe(4321);
  // Nothing clicked the button.
  await expect(page.locator("#log li")).toHaveCount(0);
});
