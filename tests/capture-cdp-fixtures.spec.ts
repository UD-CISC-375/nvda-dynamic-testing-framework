// Records tests/fixtures/cdp/*.json from this repo's live pages, for
// tests/cdp-tree.spec.ts's offline unit tests to run against (same pattern
// as tests/capture-snapshots.spec.ts recording tests/fixtures/snapshots/ —
// see 135's issue description).
//
// Skipped unless CAPTURE=1, so it never runs in CI and never runs by
// accident:
//   CAPTURE=1 npx playwright test tests/capture-cdp-fixtures.spec.ts --project=chromium
//
// Re-record whenever Playwright's pinned Chromium version changes — the CDP
// Accessibility domain is marked experimental (docs/how-it-works.md).
//
// Assumption, flagged for review:#135's acceptance criteria name "Team Y's
// dialog" and "a showModal() page" as two things to capture, alongside "the
// menu (both variants)". This spec reads the first two as two STATES of the
// same dialog scenario — closed (dialog-closed.json) and open, i.e. after
// dialog.showModal() has run (dialog-open.json) — since that pairing is
// exactly #133's motivating example: Chromium hides the inert background
// once the modal opens; the ariaSnapshot tree still lists it. If the team
// meant two different pages instead, only this file needs to change —
// getCdpTree/normalizeAXTree don't know or care where their input came from.
import { test, Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createCdpLink, resolveElement } from "./helpers/cdp-link";

test.skip(process.env.CAPTURE !== "1", "set CAPTURE=1 to (re)record tests/fixtures/cdp/*.json");

const fixturesDir = join(__dirname, "fixtures", "cdp");

const dialogUrl = (variant: "accessible" | "broken") => `#/disclosure/dialog?variant=${variant}&delay=0`;
const menuUrl = (variant: "accessible" | "broken") => `#/disclosure/menu?variant=${variant}`;

// Captures the page's whole raw Accessibility.getFullAXTree `nodes` array,
// plus (when `scopeTestId` is given) the backendNodeId of that testid's
// element — saved alongside the nodes as `meta.scopeBackendNodeId`, so
// cdp-tree.spec.ts's "root" tests have a stable, fixture-local id to pass
// without needing to re-derive it (backendNodeIds aren't meaningful outside
// the page load that produced them — #133's notes).
async function capture(page: Page, file: string, scopeTestId?: string) {
  mkdirSync(fixturesDir, { recursive: true });

  const link = await createCdpLink(page);
  if (!link.available) throw new Error(`CDP unavailable while recording ${file}: ${link.reason}`);

  const { nodes } = (await link.session.send("Accessibility.getFullAXTree")) as { nodes: unknown[] };

  const meta: Record<string, unknown> = {};
  if (scopeTestId) {
    meta.scopeBackendNodeId = await resolveElement(link, page.getByTestId(scopeTestId));
  }

  writeFileSync(join(fixturesDir, file), JSON.stringify({ nodes, meta }, null, 2));
  console.log(`[capture-cdp-fixtures] wrote tests/fixtures/cdp/${file} (${nodes.length} nodes)`);
}

test("record dialog-closed.json (Team Y's dialog, not yet opened)", async ({ page }) => {
  await page.goto(dialogUrl("accessible"));
  await page.getByTestId("trigger").waitFor();
  await capture(page, "dialog-closed.json");
});

test("record dialog-open.json (showModal() called, background inert)", async ({ page }) => {
  await page.goto(dialogUrl("accessible"));
  // Same open sequence as dialog.spec.ts's openDialog(): focus the trigger,
  // then Enter, rather than .click() (the trigger is a real <button>, so
  // either works, but this matches the existing convention in that file).
  await page.getByTestId("trigger").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Profile settings" }).waitFor();
  await capture(page, "dialog-open.json");
});

test("record menu-accessible.json, with the menu as the scoped root", async ({ page }) => {
  await page.goto(menuUrl("accessible"));
  await page.getByTestId("trigger").click();
  await page.getByTestId("menu").waitFor();
  await capture(page, "menu-accessible.json", "menu");
});

test("record menu-broken.json", async ({ page }) => {
  await page.goto(menuUrl("broken"));
  await page.getByTestId("trigger").click();
  await page.getByTestId("menu").waitFor();
  await capture(page, "menu-broken.json", "menu");
});
