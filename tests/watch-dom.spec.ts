import { test, expect } from "@playwright/test";
import { watchDom } from "./helpers/watch-dom";

// Unit tests for the watchDom helper itself. Each test builds its own page
// with page.setContent, so none of them need Team Y's site.
// Run just these with: npx playwright test --grep @unit --project=chromium

test("watchDom(page) records an element appended directly to <body>", { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`<main id="app"></main>`);
  const watcher = await watchDom(page);

  await page.evaluate(() => {
    const banner = document.createElement("div");
    banner.id = "banner";
    document.body.append(banner);
  });

  const changes = await watcher.waitFor((c) =>
    c.some((x) => x.target === "body" && x.added.includes("div#banner")),
  );
  expect(changes.length).toBeGreaterThan(0);
});

test('watchDom(page, "#a") records a change inside #a and not one outside it', { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`<div id="a"></div><div id="b"></div>`);
  const watcher = await watchDom(page, "#a");

  // Change outside #a first, then inside. The observer reports changes in
  // order, so once the inside one arrives, the outside one would already be
  // in the list if it had been recorded. No fixed wait needed.
  await page.evaluate(() => {
    document.querySelector("#b")!.append(document.createElement("span"));
    document.querySelector("#a")!.append(document.createElement("em"));
  });

  const changes = await watcher.waitFor((c) =>
    c.some((x) => x.added.includes("em")),
  );
  expect(changes.some((x) => x.added.includes("span"))).toBe(false);
  expect(changes.every((x) => x.target === "div#a")).toBe(true);
});

test('labels use tag#id, then tag[data-testid="x"], then tag', { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`
    <div id="with-id" data-testid="ignored"></div>
    <div data-testid="only-testid"></div>
    <div class="plain"></div>
  `);
  const watcher = await watchDom(page);

  await page.evaluate(() => {
    for (const el of document.querySelectorAll("div")) el.setAttribute("aria-hidden", "true");
  });

  const changes = await watcher.waitFor((c) =>
    c.filter((x) => x.attributeName === "aria-hidden").length === 3,
  );
  const targets = changes
    .filter((x) => x.attributeName === "aria-hidden")
    .map((x) => x.target);
  expect(targets).toEqual([
    "div#with-id", // id wins even when a testid is present
    'div[data-testid="only-testid"]',
    "div",
  ]);
});
