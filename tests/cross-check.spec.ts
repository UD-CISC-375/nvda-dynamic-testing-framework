// Tests for crossCheck (#136). Two kinds:
//
// - @unit: crossCheck is a pure function (no CDP session, no browser -- same
//   architecture as normalizeAXTree/#135 and diffTrees/#129), so most of its
//   rules are covered directly against hand-built AriaNode/CdpTreeNode trees,
//   no site or even a real page needed.
// - everything else: hits the real, pinned Chromium build and Team Y's live
//   site directly (per the team's move away from saved JSON fixtures -- see
//   cdp-tree.spec.ts). If one of these starts failing, check whether the
//   site changed before assuming crossCheck itself regressed.
import { test, expect, Page, Locator } from "@playwright/test";
import { crossCheck, CrossCheckMismatch, findUnexplainedBackendIds, resolveMissingReasons } from "./helpers/cross-check";
import { parseSnapshot, AriaNode } from "./helpers/parse-snapshot";
import { snapshotTree } from "./helpers/aria-tree";
import { getCdpTree, CdpTreeNode, IgnoredNode } from "./helpers/cdp-tree";
import { createCdpLink, resolveElement, resolveRefs, CdpLink } from "./helpers/cdp-link";
import { loadScenarios, SetupStep } from "./helpers/scenarios";

// Same guard cdp.spec.ts uses: CDP only exists on Chromium, and the repo
// only configures Chromium projects, so this should never actually skip --
// it's protection against a config change silently making these tests
// meaningless instead of failing confusingly.
function requireLink(link: CdpLink): asserts link is Extract<CdpLink, { available: true }> {
  test.skip(!link.available, (link as { reason?: string }).reason ?? "CDP unavailable");
}

// Minimal AriaNode/CdpTreeNode builders for @unit fixtures -- only the
// fields a test cares about need to be passed.
function node(partial: Partial<AriaNode> & { role: string }): AriaNode {
  return { states: {}, children: [], ...partial };
}
function cdpNode(partial: Partial<CdpTreeNode> & { backendNodeId: number; role: string }): CdpTreeNode {
  return { props: {}, children: [], ...partial };
}

test.describe("crossCheck: hiddenByBrowser", () => {
  test("reports an ignored node with Chromium's reasons verbatim, and doesn't re-report its children", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [
      node({
        role: "generic",
        name: "Background",
        ref: "e1",
        children: [node({ role: "button", name: "Old action", ref: "e2" })],
      }),
    ];
    const cdpTree = {
      tree: [] as CdpTreeNode[],
      ignored: new Map<number, IgnoredNode>([
        [10, { backendNodeId: 10, role: "generic", reasons: ["activeModalDialog"] }],
      ]),
    };
    const refMap = new Map([["e1", 10], ["e2", 11]]);
    expect(crossCheck(tree, cdpTree, refMap)).toEqual([
      { kind: "hiddenByBrowser", path: 'generic "Background"', ref: "e1", reasons: ["activeModalDialog"] },
    ]);
  });

  test("a node present in the kept CDP tree is never reported, even if unrelated nodes are ignored", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [node({ role: "button", name: "Go", ref: "e1" })];
    const cdpTree = {
      tree: [cdpNode({ backendNodeId: 10, role: "button", name: "Go" })],
      ignored: new Map<number, IgnoredNode>([[99, { backendNodeId: 99, role: "generic", reasons: ["notRendered"] }]]),
    };
    expect(crossCheck(tree, cdpTree, new Map([["e1", 10]]))).toEqual([]);
  });

  test("a structural omission (e.g. an implicit rowgroup) is not reported, and its child is still checked on its own", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [
      node({
        role: "table",
        ref: "e0",
        children: [node({ role: "rowgroup", ref: "e1", children: [node({ role: "row", ref: "e2" })] })],
      }),
    ];
    const cdpTree = {
      // No node at all for the rowgroup (101): Chromium folds it away and
      // exposes the row directly as the table's child.
      tree: [cdpNode({ backendNodeId: 100, role: "table", children: [cdpNode({ backendNodeId: 102, role: "row" })] })],
      ignored: new Map<number, IgnoredNode>(),
    };
    const refMap = new Map([["e0", 100], ["e1", 101], ["e2", 102]]);
    expect(crossCheck(tree, cdpTree, refMap)).toEqual([]);
  });

  test("a ref that resolveRefs couldn't resolve is skipped, not guessed at", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [node({ role: "button", name: "Gone", ref: "e1" })];
    const cdpTree = { tree: [] as CdpTreeNode[], ignored: new Map<number, IgnoredNode>() };
    expect(crossCheck(tree, cdpTree, new Map())).toEqual([]);
  });

  // Caught against the real site: a table's rowgroup shows up in `ignored`
  // with reason "uninteresting" (not a hidden-from-AT reason at all -- just
  // Chromium's own structural pruning heuristic), while its row is exposed
  // directly as the table's child, the same way normalizeAXTree's own
  // ignored-node child-promotion works for the kept tree. This is the AC's
  // "structural node whose content Chromium still exposes" case, reached
  // through `ignored` instead of a missing AXNode entirely.
  test("an ignored node whose content is still exposed through a child (e.g. a table's rowgroup) is not reported", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [
      node({
        role: "table",
        ref: "e0",
        children: [node({ role: "rowgroup", ref: "e1", children: [node({ role: "row", ref: "e2" })] })],
      }),
    ];
    const cdpTree = {
      tree: [cdpNode({ backendNodeId: 100, role: "table", children: [cdpNode({ backendNodeId: 102, role: "row" })] })],
      ignored: new Map<number, IgnoredNode>([[101, { backendNodeId: 101, role: "rowgroup", reasons: ["uninteresting"] }]]),
    };
    const refMap = new Map([["e0", 100], ["e1", 101], ["e2", 102]]);
    expect(crossCheck(tree, cdpTree, refMap)).toEqual([]);
  });
});

test.describe("crossCheck: missingFromSnapshot", () => {
  test("reports a named CDP node nothing stands for", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [node({ role: "main", ref: "e1" })];
    const cdpTree = {
      tree: [cdpNode({ backendNodeId: 10, role: "main", children: [cdpNode({ backendNodeId: 11, role: "button", name: "Surprise" })] })],
      ignored: new Map<number, IgnoredNode>(),
    };
    expect(crossCheck(tree, cdpTree, new Map([["e1", 10]]))).toEqual([
      { kind: "missingFromSnapshot", path: 'main > button "Surprise"', backendNodeId: 11, role: "button", name: "Surprise" },
    ]);
  });

  test("reports an unnamed but focusable CDP node nothing stands for", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [node({ role: "main", ref: "e1" })];
    const cdpTree = {
      tree: [cdpNode({ backendNodeId: 10, role: "main", children: [cdpNode({ backendNodeId: 11, role: "div", props: { focusable: true } })] })],
      ignored: new Map<number, IgnoredNode>(),
    };
    const result = crossCheck(tree, cdpTree, new Map([["e1", 10]]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "missingFromSnapshot", backendNodeId: 11 });
  });

  test("an unnamed, unfocusable CDP node nothing stands for is not reported", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [node({ role: "main", ref: "e1" })];
    const cdpTree = {
      tree: [cdpNode({ backendNodeId: 10, role: "main", children: [cdpNode({ backendNodeId: 11, role: "group" })] })],
      ignored: new Map<number, IgnoredNode>(),
    };
    expect(crossCheck(tree, cdpTree, new Map([["e1", 10]]))).toEqual([]);
  });

  test("ref-less <option> lines are matched to CDP children by role+name under their matched parent", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [
      node({
        role: "combobox",
        name: "Color",
        ref: "e1",
        children: [node({ role: "option", name: "Red" }), node({ role: "option", name: "Blue" })],
      }),
    ];
    const cdpTree = {
      tree: [
        cdpNode({
          backendNodeId: 10,
          role: "combobox",
          name: "Color",
          children: [
            cdpNode({ backendNodeId: 11, role: "option", name: "Red" }),
            cdpNode({ backendNodeId: 12, role: "option", name: "Blue" }),
          ],
        }),
      ],
      ignored: new Map<number, IgnoredNode>(),
    };
    expect(crossCheck(tree, cdpTree, new Map([["e1", 10]]))).toEqual([]);
  });

  test("a focused button inside aria-hidden has no snapshot line at all, but is still reported missing", { tag: "@unit" }, () => {
    // Nothing in `tree` stands for the hidden button -- not even a ref-less
    // line, since content mode drops aria-hidden subtrees entirely. Chromium
    // still exposes it (it's the focused element), so it's missing.
    const tree: AriaNode[] = [node({ role: "main", ref: "e1" })];
    const cdpTree = {
      tree: [
        cdpNode({
          backendNodeId: 10,
          role: "main",
          children: [cdpNode({ backendNodeId: 11, role: "button", name: "Hidden but focused", props: { focusable: true } })],
        }),
      ],
      ignored: new Map<number, IgnoredNode>(),
    };
    const result = crossCheck(tree, cdpTree, new Map([["e1", 10]]));
    expect(result).toEqual([
      { kind: "missingFromSnapshot", path: 'main > button "Hidden but focused"', backendNodeId: 11, role: "button", name: "Hidden but focused" },
    ]);
  });

  // Caught against the real site: a native <select> always has a
  // MenuListPopup node in Chromium's full tree listing its <option>s, even
  // while the dropdown is closed -- an implementation detail of the native
  // widget, not something any snapshot walks into while collapsed.
  test("a native <select>'s MenuListPopup/option internals are never reported missing", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [node({ role: "combobox", name: "Color", ref: "e1" })];
    const cdpTree = {
      tree: [
        cdpNode({
          backendNodeId: 10,
          role: "combobox",
          name: "Color",
          children: [
            cdpNode({
              backendNodeId: 11,
              role: "MenuListPopup",
              children: [
                cdpNode({ backendNodeId: 12, role: "option", name: "Red" }),
                cdpNode({ backendNodeId: 13, role: "option", name: "Blue" }),
              ],
            }),
          ],
        }),
      ],
      ignored: new Map<number, IgnoredNode>(),
    };
    expect(crossCheck(tree, cdpTree, new Map([["e1", 10]]))).toEqual([]);
  });
});

// Caught against the real site: a plain `inert` region's own content can be
// absent from Chromium's full tree ENTIRELY -- explained by neither the kept
// tree nor the ignored map -- which is exactly what findUnexplainedBackendIds
// exists to tell apart from walkHidden's other "explained by neither" case
// (a folded-away structural wrapper, e.g. a rowgroup). This is the pure half
// of resolveMissingReasons's fix, so it's covered here with no CDP session;
// the live getPartialAXTree round trip itself is only exercised against the
// real site, below.
test.describe("findUnexplainedBackendIds", () => {
  test("flags a resolved backendNodeId that's in neither the kept tree nor ignored", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [node({ role: "button", name: "Can't reach me", ref: "e1" })];
    const cdpById = new Map<number, CdpTreeNode>(); // nothing kept
    const ignored = new Map<number, IgnoredNode>(); // nothing ignored either
    const refMap = new Map([["e1", 7]]);
    expect(findUnexplainedBackendIds(tree, refMap, cdpById, ignored)).toEqual(new Set([7]));
  });

  test("does not flag a backendNodeId that's already kept, already ignored, or never resolved", { tag: "@unit" }, () => {
    const tree: AriaNode[] = [
      node({ role: "button", name: "Kept", ref: "e1" }),
      node({ role: "button", name: "Ignored", ref: "e2" }),
      node({ role: "button", name: "Stale ref", ref: "e3" }),
    ];
    const cdpById = new Map<number, CdpTreeNode>([[10, cdpNode({ backendNodeId: 10, role: "button", name: "Kept" })]]);
    const ignored = new Map<number, IgnoredNode>([[11, { backendNodeId: 11, role: "button", reasons: ["ariaHiddenElement"] }]]);
    const refMap = new Map([["e1", 10], ["e2", 11]]); // e3 never resolved
    expect(findUnexplainedBackendIds(tree, refMap, cdpById, ignored)).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// Live site: builds `tree`/`cdpTree`/`refMap` from a real, settled page and
// runs crossCheck against them for real.
// ---------------------------------------------------------------------------

// All ref ids in a solo ai-mode snapshot's text (refOf, in aria-tree.ts,
// returns just the first match for a pattern; this collects every one).
function allRefs(refsText: string): string[] {
  return [...refsText.matchAll(/\[ref=(\w+)\]/g)].map((m) => m[1]);
}

// Wires up one real crossCheck run: a merged snapshot tree and a CDP tree,
// both scoped to `scope` from the same settled moment, matched by a refMap
// built from a SOLO ai-mode snapshot taken immediately before resolving --
// not off snapshotTree()'s own pair (see cdp-link.ts's resolveRefs doc
// comment on why that isn't safe to resolve refs against).
//
// Also runs resolveMissingReasons and merges its result into cdpTree.ignored
// before calling the pure crossCheck -- #136's own documented fallback for a
// backendNodeId Chromium's full tree omits entirely (confirmed against a
// real capture: a plain `inert` region's content, see the test below). Every
// live test and the full scenario sweep go through this one helper, so all
// of them get the same fallback, not just the fixture that first caught it.
async function crossCheckLive(link: Extract<CdpLink, { available: true }>, scope: Locator): Promise<CrossCheckMismatch[]> {
  const snap = await snapshotTree(scope);
  const { tree } = parseSnapshot(snap);

  const root = await resolveElement(link, scope);
  const cdpTree = await getCdpTree(link, { root });

  const refsText = await scope.ariaSnapshot({ mode: "ai" });
  const refMap = await resolveRefs(link, allRefs(refsText));

  const extraIgnored = await resolveMissingReasons(link, tree, cdpTree, refMap);
  for (const [backendNodeId, ig] of extraIgnored) cdpTree.ignored.set(backendNodeId, ig);

  return crossCheck(tree, cdpTree, refMap);
}

test.describe("crossCheck: live site", () => {
  // NOTE on this one: the first version of this test ran against Team Y's
  // OWN dialog scenario and got 0 hiddenByBrowser entries. That's expected,
  // not a bug -- re-reading #136's AC, "showModal() fixture" and "Team Y's
  // dialog (div role=dialog aria-modal)" are two SEPARATE line items for a
  // reason: Team Y's dialog is a custom div, not a native <dialog>, so it
  // manages its own aria-hidden background by hand -- which ariaSnapshot
  // already excludes from content the same way CDP excludes it from the
  // accessible tree, so there's nothing to mismatch (that's exactly what
  // the "no mismatches" test below checks, and it passed). "showModal()
  // fixture" means an actual native <dialog>.showModal() call, which is
  // its own, separate browser mechanism (the HTML spec makes everything
  // outside the dialog inert automatically) -- built here by hand instead.
  test("a native <dialog>.showModal() makes the rest of the page hiddenByBrowser, with whatever reason Chromium actually gives it", async ({ page }) => {
    await page.setContent(`
      <main>
        <button id="opener">Open</button>
        <p id="bg">Background content</p>
        <dialog id="d"><p>Dialog content</p><button id="close">Close</button></dialog>
      </main>`);
    const link = await createCdpLink(page);
    requireLink(link);

    await page.locator("#d").evaluate((d: HTMLDialogElement) => d.showModal());
    await expect(page.locator("#d")).toBeVisible();

    const result = await crossCheckLive(link, page.locator("body"));
    const hidden = result.filter((m): m is Extract<CrossCheckMismatch, { kind: "hiddenByBrowser" }> => m.kind === "hiddenByBrowser");

    // #136's AC isn't sure in advance which reason showModal()'s automatic
    // background-inertness uses (inertElement vs. activeModalDialog) --
    // this is deliberately not pinned to one, so this test keeps working
    // either way. Whichever it is, it's worth a look in the PR.
    console.log("showModal() background hiddenByBrowser reasons:", hidden.map((h) => h.reasons));
    expect(hidden.length).toBeGreaterThan(0);
    for (const h of hidden) expect(h.reasons.length).toBeGreaterThan(0);
  });

  // Confirmed against a real capture: unlike the showModal() case above,
  // Chromium's Accessibility.getFullAXTree doesn't even list an AXNode for a
  // plain inert region's content -- not ignored:true with a reason, just
  // absent (resolveMissingReasons's own doc comment has the full story).
  // crossCheckLive's getPartialAXTree fallback is what turns that into a
  // real hiddenByBrowser report, with the AC's own named reason
  // (inertElement), not a guess.
  test("a plain inert region's content is hiddenByBrowser, reason inertElement", async ({ page }) => {
    await page.setContent(`
      <main>
        <div inert id="region">
          <button>Can't reach me</button>
        </div>
        <p>Unrelated content</p>
      </main>`);
    const link = await createCdpLink(page);
    requireLink(link);

    const result = await crossCheckLive(link, page.locator("body"));
    const hidden = result.filter((m): m is Extract<CrossCheckMismatch, { kind: "hiddenByBrowser" }> => m.kind === "hiddenByBrowser");

    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.some((h) => h.reasons.includes("inertElement"))).toBe(true);
  });

  test("a focused button inside aria-hidden is reported missingFromSnapshot", async ({ page }) => {
    await page.setContent(`
      <main>
        <div aria-hidden="true">
          <button id="trapped">Trapped</button>
        </div>
      </main>`);
    const link = await createCdpLink(page);
    requireLink(link);

    // focus() doesn't require the element to pass Playwright's actionability
    // checks (visible/enabled/etc.), unlike click() -- this element is
    // perfectly visible, just aria-hidden, which is exactly the scenario.
    await page.locator("#trapped").focus();

    const result = await crossCheckLive(link, page.locator("body"));
    expect(result).toEqual([
      expect.objectContaining({ kind: "missingFromSnapshot", role: "button", name: "Trapped" }),
    ]);
  });

  test("Team Y's dialog (role=dialog, aria-modal): no mismatches once open", async ({ page }) => {
    await page.goto("#/disclosure/dialog?variant=accessible&delay=0");
    await page.getByTestId("trigger").waitFor();
    const link = await createCdpLink(page);
    requireLink(link);

    await page.getByTestId("trigger").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Profile settings" }).waitFor();

    // Scoped to just the dialog itself (not the whole scenario-root, which
    // still legitimately has an inert/hidden background -- that's the
    // showModal() test above, not this one): asks whether the dialog's OWN
    // content is faithfully exposed, which is what "no mismatches" means here.
    const result = await crossCheckLive(link, page.getByRole("dialog", { name: "Profile settings" }));
    expect(result).toEqual([]);
  });

  test("Team Y's sortable table: no rowgroup mismatch", async ({ page }) => {
    await page.goto("#/dynamic/sortable-table?variant=accessible");
    const scope = page.getByTestId("scenario-root");
    await expect(page.getByRole("button", { name: "Name" })).toBeVisible();
    const link = await createCdpLink(page);
    requireLink(link);

    const result = await crossCheckLive(link, scope);
    expect(result).toEqual([]);
  });

  test("a native <select>'s options are not reported missing", async ({ page }) => {
    await page.setContent(`
      <main>
        <label>Color <select><option>Red</option><option>Blue</option></select></label>
      </main>`);
    const link = await createCdpLink(page);
    requireLink(link);

    const result = await crossCheckLive(link, page.locator("body"));
    expect(result).toEqual([]);
  });

  test("Team Y's combobox: no mismatches once its listbox is open", async ({ page }) => {
    await page.goto("#/dynamic/combobox?variant=accessible");
    const scope = page.getByTestId("scenario-root");
    await expect(scope).toBeVisible();
    const link = await createCdpLink(page);
    requireLink(link);

    await page.getByRole("combobox", { name: "Favorite fruit" }).fill("ap");
    await page.getByRole("listbox", { name: "Fruits" }).waitFor();

    const result = await crossCheckLive(link, scope);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every Team Y scenario, both variants: expect 0 mismatches overall. Per
// #136's own AC: "investigate any that show up and note them in the PR" --
// this is the one place in this file where a real failure might not mean
// crossCheck itself is wrong; it could just as easily mean a scenario (an
// "accessible" one especially) has a genuine snapshot/browser mismatch worth
// reporting on its own.
// ---------------------------------------------------------------------------

async function applySetup(page: Page, steps: SetupStep[]): Promise<void> {
  for (const step of steps) {
    const locator = page.getByTestId(step.testid);
    if (step.action === "click") await locator.click();
    else if (step.action === "fill") await locator.fill(step.value ?? "");
    else if (step.action === "press") await locator.press(step.value ?? "");
    else if (step.action === "waitFor") await locator.waitFor();
  }
}

test.describe("crossCheck: every Team Y scenario", () => {
  test("every scenario and variant reports 0 mismatches", async ({ page, request }, testInfo) => {
    const scenarios = await loadScenarios(request);
    const failures: string[] = [];

    for (const scenario of scenarios) {
      for (const variant of ["accessible", "broken"] as const) {
        await page.goto(scenario.urls[variant]);
        await applySetup(page, scenario.setup);

        const link = await createCdpLink(page);
        if (!link.available) continue; // same non-Chromium guard as requireLink, without skipping the whole sweep

        const result = await crossCheckLive(link, page.getByTestId("scenario-root"));
        if (result.length > 0) {
          failures.push(`${scenario.id} (${variant}): ${result.length} mismatch(es)`);
          await testInfo.attach(`crosscheck-${scenario.id}-${variant}.json`, {
            body: JSON.stringify(result, null, 2),
            contentType: "application/json",
          });
        }
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
