import { test, expect, Page, Locator } from "@playwright/test";
import { createCdpLink, resolveElement, resolveRefs, CdpLink } from "./helpers/cdp-link";
import { snapshotTree, waitForTreeChange, refOf } from "./helpers/aria-tree";
import { watchDom } from "./helpers/watch-dom";

// Duplicated from menu.spec.ts on purpose; importing from a spec file would
// register its tests (same convention as menu-aria-tree.spec.ts).
const menuUrl = (variant: "accessible" | "broken") => `#/disclosure/menu?variant=${variant}`;

// snapshotTree() (aria-tree.ts) takes its "content" and "ai" mode snapshots
// concurrently via Promise.all. That's fine for reading ref ids as plain
// text, but anything that's about to resolve a ref through an aria-ref=
// locator needs refs minted by a SOLO ai-mode snapshot, taken immediately
// before — otherwise the ref can come back unresolvable (count() === 0, or
// elementHandle() hanging to its timeout) even though the id is sitting
// right there in the snapshot text. See cdp-link.ts's resolveRefs() doc
// comment for the full story.
function refsNow(scope: Locator): Promise<string> {
  return scope.ariaSnapshot({ mode: "ai" });
}

// Narrows a CdpLink to its available branch, or skips the test. CDP only
// exists on Chromium, and the repo only configures Chromium projects, so this
// should never actually skip here — it's a guard against a config change
// silently making these tests meaningless instead of failing confusingly.
function requireLink(link: CdpLink): asserts link is Extract<CdpLink, { available: true }> {
  test.skip(!link.available, (link as { reason?: string }).reason ?? "CDP unavailable");
}

test(
  "createCdpLink resolves { available: false } outside Chromium, without throwing",
  { tag: "@unit" },
  async () => {
    // A fake page: just enough shape for createCdpLink to read the browser's
    // type from, so this doesn't need a real Firefox/WebKit project (the repo
    // doesn't have one).
    const fakePage = {
      context: () => ({
        browser: () => ({
          browserType: () => ({ name: () => "firefox" }),
        }),
      }),
    } as unknown as Page;

    const link = await createCdpLink(fakePage);
    expect(link).toEqual({ available: false, reason: "not Chromium" });
  },
);

test(
  "createCdpLink reuses one session per page",
  { tag: "@unit" },
  async ({ page }) => {
    const [first, second] = await Promise.all([createCdpLink(page), createCdpLink(page)]);
    requireLink(first);
    requireLink(second);
    // Same resolved object, not just an equivalent one: calling twice (even
    // concurrently) must not open a second CDP session.
    expect(second.session).toBe(first.session);
  },
);

test(
  "the session is detached when the page closes",
  { tag: "@unit" },
  async ({ browser }) => {
    // A throwaway page, so closing it here doesn't interfere with
    // Playwright's own cleanup of the `page` fixture.
    const page = await browser.newPage();
    const link = await createCdpLink(page);
    requireLink(link);

    let detachCalled = false;
    const originalDetach = link.session.detach.bind(link.session);
    link.session.detach = async () => {
      detachCalled = true;
      await originalDetach();
    };

    await page.close();
    expect(detachCalled).toBe(true);
  },
);

test(
  "resolveRefs resolves valid refs and leaves out stale/unknown ones",
  { tag: "@unit" },
  async ({ page }) => {
    await page.setContent(`<button id="go">Go</button>`);
    const scope = page.locator("body");

    const link = await createCdpLink(page);
    requireLink(link);

    // A solo snapshot, taken right before resolving — see refsNow()'s
    // comment for why snapshotTree() can't be used to source this ref.
    const ref = refOf(await refsNow(scope), /button "Go"/);
    expect(ref).toBeDefined();

    const result = await resolveRefs(link, [ref!, "e9999-does-not-exist"]);

    expect(result.size).toBe(1);
    expect(result.has(ref!)).toBe(true);
    expect(typeof result.get(ref!)).toBe("number");
    expect(result.has("e9999-does-not-exist")).toBe(false);
  },
);

test(
  "resolveElement resolves a locator's backendNodeId, stable across repeated calls",
  { tag: "@unit" },
  async ({ page }) => {
    // Stands in for what a future tracker would pass as its scope.
    await page.setContent(`<main id="scope"><button id="go">Go</button></main>`);
    const link = await createCdpLink(page);
    requireLink(link);

    const scope = page.locator("#scope");
    const first = await resolveElement(link, scope);
    const second = await resolveElement(link, scope);

    expect(typeof first).toBe("number");
    // Same DOM node, resolved twice: same backendNodeId both times.
    expect(second).toBe(first);
  },
);

test(
  "resolving refs does not create any DOM mutations watchDom would record",
  { tag: "@unit" },
  async ({ page }) => {
    await page.setContent(`<button id="go">Go</button><button id="stop">Stop</button>`);
    const scope = page.locator("body");

    const link = await createCdpLink(page);
    requireLink(link);

    // A solo snapshot, taken right before resolving — see refsNow()'s
    // comment for why snapshotTree() can't be used to source these refs.
    const refsText = await refsNow(scope);
    const refs = [refOf(refsText, /button "Go"/), refOf(refsText, /button "Stop"/)].filter(
      (r): r is string => r !== undefined,
    );
    expect(refs).toHaveLength(2);

    // Stands in for a future tracker's `.watcher` (there's no tracker yet;
    // that's #139). watchDom only allows one watcher per page, which is
    // exactly why the lookup can't tag elements with a data- attribute to
    // find its way back to them later: a tracker running this alongside its
    // own watcher has no way to start a second one just to check.
    const watcher = await watchDom(page);

    const resolved = await resolveRefs(link, refs);

    // Not just "no mutations": prove the lookup actually resolved both refs,
    // or a silently-broken resolveRefs would pass this test for free.
    expect(resolved.size).toBe(2);
    expect(watcher.changes).toEqual([]);
  },
);

test("the menu button's ref resolves to the same backendNodeId before and after the menu opens", async ({
  page,
}) => {
  await page.goto(menuUrl("accessible"));
  await expect(page.getByTestId("trigger")).toBeVisible();

  const link = await createCdpLink(page);
  requireLink(link);

  const scope = page.locator("body");

  // Resolve the "before" id off its own solo snapshot, taken immediately
  // before use — see refsNow()'s comment for why.
  const refBefore = refOf(await refsNow(scope), /button "Actions"/);
  expect(refBefore).toBeDefined();

  const idBefore = await resolveElement(link, page.locator(`aria-ref=${refBefore}`));
  expect(typeof idBefore).toBe("number");

  // Track content with snapshotTree/waitForTreeChange as usual, purely to
  // know when the click's effect has settled. Only the returned .refs TEXT
  // is read here (via refOf, a regex match) — nothing is resolved through
  // aria-ref= off of it, since that snapshot was taken concurrently with a
  // non-ai one and its ref table isn't trustworthy to resolve against.
  const before = await snapshotTree(scope);
  await page.getByTestId("trigger").click();
  const after = await waitForTreeChange(scope, before);

  // Same ref (already covered by menu-aria-tree.spec.ts) is the actual point
  // of this test: the element itself didn't change identity just because its
  // state did. Confirmed here as a string match; resolved below off a fresh
  // snapshot rather than this one.
  const refAfterText = refOf(after.refs, /button "Actions"/);
  expect(refAfterText).toBe(refBefore);

  const refAfter = refOf(await refsNow(scope), /button "Actions"/);
  expect(refAfter).toBe(refBefore);

  const idAfter = await resolveElement(link, page.locator(`aria-ref=${refAfter}`));
  expect(idAfter).toBe(idBefore);
});
