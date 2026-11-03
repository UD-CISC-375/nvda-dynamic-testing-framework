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

test("el.focus() records a focus change with the focused element as target", { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`<button id="a">A</button>`);
  const watcher = await watchDom(page);

  await page.evaluate(() => document.querySelector<HTMLElement>("#a")!.focus());

  const changes = await watcher.waitFor((c) => c.some((x) => x.type === "focus"));
  expect(changes.find((x) => x.type === "focus")).toEqual({
    type: "focus",
    target: "button#a",
    attributeName: null,
    oldValue: null, // focus came from <body>
    newValue: null,
    added: [],
    removed: [],
    text: null,
    inLiveRegion: false,
  });
});

test("a focus change's oldValue is the previously focused element", { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`<button id="a">A</button><button id="b">B</button>`);
  const watcher = await watchDom(page);

  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#a")!.focus();
    document.querySelector<HTMLElement>("#b")!.focus();
  });

  const changes = await watcher.waitFor((c) =>
    c.some((x) => x.type === "focus" && x.target === "button#b"),
  );
  expect(changes.find((x) => x.target === "button#b")!.oldValue).toBe("button#a");
});

test("focus moved with the Tab key is recorded", { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`<button id="a">A</button><button id="b">B</button>`);
  const watcher = await watchDom(page);

  await page.keyboard.press("Tab");

  await watcher.waitFor((c) =>
    c.some((x) => x.type === "focus" && x.target === "button#a"),
  );
});

test("a focus move made after a DOM change is recorded after it", { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`<form id="form"><button>Send</button></form>`);
  const watcher = await watchDom(page);

  // Same task, like a submit handler: the observer hasn't delivered the
  // replacement yet when focus() fires focusin.
  await page.evaluate(() => {
    const msg = document.createElement("p");
    msg.id = "msg";
    msg.tabIndex = -1;
    document.querySelector("#form")!.replaceWith(msg);
    msg.focus();
  });

  const changes = await watcher.waitFor((c) => c.some((x) => x.type === "focus"));
  const replaced = changes.findIndex((x) => x.added.includes("p#msg"));
  const focused = changes.findIndex((x) => x.type === "focus" && x.target === "p#msg");
  expect(replaced).toBeGreaterThanOrEqual(0);
  expect(focused).toBeGreaterThan(replaced);
});

test('watchDom(page, "#a") does not record focus moving outside #a', { tag: "@unit" }, async ({ page }) => {
  await page.setContent(`
    <div id="a"><button id="in">In</button></div>
    <div id="b"><button id="out">Out</button></div>
  `);
  const watcher = await watchDom(page, "#a");

  // Outside first, then inside: once the inside one arrives, the outside one
  // would already be in the list if it had been recorded.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#out")!.focus();
    document.querySelector<HTMLElement>("#in")!.focus();
  });

  const changes = await watcher.waitFor((c) =>
    c.some((x) => x.type === "focus" && x.target === "button#in"),
  );
  expect(changes.some((x) => x.target === "button#out")).toBe(false);
  // oldValue may still name an element outside the root: it's where focus came from.
  expect(changes.find((x) => x.target === "button#in")!.oldValue).toBe("button#out");
});
