// Import only the Page and TestInfo types from Playwright (no runtime code).
import type { Page, TestInfo } from "@playwright/test";

// What one spec needs to say about its trigger step.
export type TriggerOptions = {
  // Instruction printed to the console for the person in manual mode.
  prompt: string;
  // Resolves once the person has done the action; the helper supplies the timeout.
  humanDone: (timeout: number) => Promise<void>;
  // The automated action. Defaults to clicking the element with data-testid="trigger".
  auto?: () => Promise<void>;
};

// Cause a scenario's change: automatically, or by a person in the "manual" project.
// Either way, any watcher started earlier sees the same DOM change.
export async function trigger(
  page: Page,
  // Only project and timeout are read, so tests can pass a small fake.
  testInfo: Pick<TestInfo, "project" | "timeout">,
  { prompt, humanDone, auto = () => page.getByTestId("trigger").click() }: TriggerOptions,
): Promise<void> {
  // The manual project runs headed and waits for a person instead of acting.
  if (testInfo.project.name === "manual") {
    // Tell the person what to do in the browser window.
    console.log(prompt);
    // Wait for the whole test timeout, so no spec hardcodes a shorter one.
    await humanDone(testInfo.timeout);
    return;
  }
  // Every other project performs the action itself.
  await auto();
}
