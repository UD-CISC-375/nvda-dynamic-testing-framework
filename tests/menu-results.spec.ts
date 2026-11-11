import { expect, test } from "@playwright/test";
import { runAxe } from "./helpers/axe";
import { attachMenuResult, captureMenuSnapshot } from "./helpers/menu-results";
import type { ScenarioResult } from "../results/schema";

test("records new and resolved axe findings from the observed menu states", async ({ page }, testInfo) => {
  await page.setContent(`
    <html lang="en"><head><title>Menu test</title></head><body>
      <main>
        <button data-testid="trigger" aria-expanded="false"></button>
        <div data-testid="menu" hidden></div>
      </main>
      <script>
        document.querySelector('[data-testid="trigger"]').addEventListener('click', () => {
          const button = document.querySelector('[data-testid="trigger"]');
          button.setAttribute('aria-label', 'Actions');
          button.setAttribute('aria-expanded', 'true');
          const menu = document.querySelector('[data-testid="menu"]');
          menu.hidden = false;
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-label', 'Actions');
          menu.innerHTML = '<div role="menuitem">One</div><div role="menuitem">Two</div><div role="menuitem">Three</div><div role="menuitem">Four</div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
        });
      </script>
    </body></html>
  `);
  const trigger = page.getByTestId("trigger");
  const before = await captureMenuSnapshot(trigger, await runAxe(page, testInfo, "before"));
  await trigger.click();
  const after = await captureMenuSnapshot(trigger, await runAxe(page, testInfo, "after"));
  await attachMenuResult(testInfo, "fixture", before, after, page.getByTestId("menu"));

  const attachment = testInfo.attachments.find((item) => item.name === "accessibility-scenario.json");
  if (!attachment?.body) throw new Error("The scenario result attachment is missing");
  const result: ScenarioResult = JSON.parse(attachment.body.toString());
  expect(result.verdict).toBe("failed");
  expect(result.states[0].axe.new.map((finding) => finding.rule)).toContain("button-name");
  expect(result.states[1].axe.new.map((finding) => finding.rule)).toContain("image-alt");
  expect(result.states[1].axe.resolved.map((finding) => finding.rule)).toContain("button-name");
  expect(result.states[1].treeDiff.added[0].subtree.properties.role).toBe("menu");
  expect(result.states[1].treeDiff.added[0].subtree.children).toHaveLength(4);
  expect(result.states[1].assistiveTechChanges).toContain("Changed: button with no accessible name, name not exposed to Actions");
  expect(result.states[1].assistiveTechChanges).toContain("Changed: button with no accessible name, expanded false to true");
  for (const finding of [...result.states[1].axe.new, ...result.states[1].axe.resolved]) {
    expect(finding.help).not.toBe("");
    expect(finding.helpUrl).toMatch(/^https:\/\//);
    expect(finding.failureSummary).not.toBe("");
    expect(finding.html).not.toBe("");
  }
});
