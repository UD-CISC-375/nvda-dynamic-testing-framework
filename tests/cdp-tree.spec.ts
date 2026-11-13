// Unit tests for normalizeAXTree/getCdpTree (#135). Most of these need no
// browser at all: they feed hand-built Accessibility.getFullAXTree `nodes`
// arrays straight into normalizeAXTree. The "live site" block at the bottom
// hits the real, pinned Chromium build directly instead of saved JSON
// fixtures (per team review: a committed fixture file was by far the
// biggest share of this PR's diff, for little benefit over just running
// against the site — this code barely has a reason to run without a
// browser). If one of those live tests starts failing, check whether Team
// Y's site changed recently before assuming this code regressed.
import { test, expect } from "@playwright/test";
import { normalizeAXTree, getCdpTree, AXNode, IgnoredNode } from "./helpers/cdp-tree";
import { createCdpLink, resolveElement } from "./helpers/cdp-link";

// Shorthand for building a minimal AXNode by hand, for tests that need exact
// control rather than a real capture. Only the fields a test cares about
// need to be passed; the rest default to "a normal, unignored, named node".
function node(partial: Partial<AXNode> & { nodeId: string }): AXNode {
  return { ignored: false, ...partial };
}

test.describe("normalizeAXTree: noise filtering", () => {
  // Every role in NOISE_ROLES, plus a node with no backendDOMNodeId, all
  // wrapping (or standing in front of) a real, identifiable button — so a
  // single assertion on the final tree's shape proves each one was dropped.
  const nodes: AXNode[] = [
    node({ nodeId: "root", role: { value: "WebArea" }, name: { value: "Page" }, childIds: ["wrapper"], backendDOMNodeId: 1 }),
    // "none" (ARIA presentation) wraps the button: dropped, but its child
    // (the button) is promoted up to the root's children.
    node({ nodeId: "wrapper", role: { value: "none" }, childIds: ["statictext", "button", "noBackend"], backendDOMNodeId: 2 }),
    node({ nodeId: "statictext", role: { value: "StaticText" }, name: { value: "ignored text" }, backendDOMNodeId: 3 }),
    node({ nodeId: "button", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 4 }),
    // No backendDOMNodeId at all: noise, same as a negative one would be.
    node({ nodeId: "noBackend", role: { value: "generic" }, name: { value: "Phantom" } }),
  ];

  test("drops noise roles and nodes with no backendDOMNodeId, promoting real children", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree(nodes);
    expect(tree).toHaveLength(1);
    expect(tree[0].role).toBe("WebArea");
    // Only the button survived: StaticText, the no-backend node, and the
    // "none" wrapper itself are all gone, not present anywhere in the tree.
    expect(tree[0].children).toEqual([
      { backendNodeId: 4, role: "button", name: "Go", description: undefined, props: {}, nameFrom: undefined, children: [] },
    ]);
  });

  test("treats a negative backendDOMNodeId the same as a missing one", { tag: "@unit" }, () => {
    const negative = normalizeAXTree([
      node({ nodeId: "root", role: { value: "WebArea" }, childIds: ["neg"], backendDOMNodeId: 1 }),
      node({ nodeId: "neg", role: { value: "button" }, name: { value: "Ghost" }, backendDOMNodeId: -1 }),
    ]);
    expect(negative.tree[0].children).toEqual([]);
  });
});

test.describe("normalizeAXTree: unnamed generic flattening", () => {
  test("flattens an unnamed generic, promoting its children", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree([
      node({ nodeId: "root", role: { value: "WebArea" }, childIds: ["wrapper"], backendDOMNodeId: 1 }),
      // No `name` at all: unnamed.
      node({ nodeId: "wrapper", role: { value: "generic" }, childIds: ["button"], backendDOMNodeId: 2 }),
      node({ nodeId: "button", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 3 }),
    ]);
    expect(tree[0].children.map((n) => n.role)).toEqual(["button"]);
  });

  test("keeps a NAMED generic as a real node", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree([
      node({ nodeId: "root", role: { value: "WebArea" }, childIds: ["wrapper"], backendDOMNodeId: 1 }),
      node({
        nodeId: "wrapper",
        role: { value: "generic" },
        name: { value: "Toolbar" },
        childIds: ["button"],
        backendDOMNodeId: 2,
      }),
      node({ nodeId: "button", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 3 }),
    ]);
    expect(tree[0].children.map((n) => [n.role, n.name])).toEqual([["generic", "Toolbar"]]);
    expect(tree[0].children[0].children.map((n) => n.role)).toEqual(["button"]);
  });
});

test.describe("normalizeAXTree: ignored nodes", () => {
  const nodes: AXNode[] = [
    node({ nodeId: "root", role: { value: "WebArea" }, childIds: ["bg", "dialog"], backendDOMNodeId: 1 }),
    node({
      nodeId: "bg",
      role: { value: "generic" },
      name: { value: "Background" },
      ignored: true,
      ignoredReasons: [{ name: "inertSubtree" }],
      childIds: ["bgButton"],
      backendDOMNodeId: 2,
    }),
    // Nested under an ignored node, but not itself ignored -- still found
    // and kept, per normalizeAXTree's doc comment on why ignored nodes'
    // children are still walked.
    node({ nodeId: "bgButton", role: { value: "button" }, name: { value: "Old action" }, backendDOMNodeId: 3 }),
    node({ nodeId: "dialog", role: { value: "dialog" }, name: { value: "Profile settings" }, backendDOMNodeId: 4 }),
  ];

  test("excludes an ignored node from the tree but records it with its reasons", { tag: "@unit" }, () => {
    const { tree, ignored } = normalizeAXTree(nodes);
    expect(tree[0].children.map((n) => n.role)).toEqual(["button", "dialog"]);
    const expected: IgnoredNode = { backendNodeId: 2, role: "generic", reasons: ["inertSubtree"] };
    expect(ignored.get(2)).toEqual(expected);
  });

  test("still keeps a non-ignored node nested under an ignored one", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree(nodes);
    expect(tree[0].children.find((n) => n.role === "button")?.name).toBe("Old action");
  });
});

test.describe("normalizeAXTree: root scoping", () => {
  const nodes: AXNode[] = [
    node({ nodeId: "root", role: { value: "WebArea" }, childIds: ["heading", "menu"], backendDOMNodeId: 1 }),
    node({ nodeId: "heading", role: { value: "heading" }, name: { value: "Page title" }, backendDOMNodeId: 2 }),
    node({ nodeId: "menu", role: { value: "menu" }, name: { value: "Actions" }, childIds: ["item1"], backendDOMNodeId: 3 }),
    node({ nodeId: "item1", role: { value: "menuitem" }, name: { value: "Rename" }, backendDOMNodeId: 4 }),
  ];

  test("with a root, only that element's subtree is kept", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree(nodes, { root: 3 });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ backendNodeId: 3, role: "menu", name: "Actions" });
    // The heading (backendNodeId 2), outside the menu, must not appear.
    expect(JSON.stringify(tree)).not.toContain("Page title");
    expect(tree[0].children.map((n) => n.name)).toEqual(["Rename"]);
  });

  test("an unknown root backendNodeId returns an empty tree rather than throwing", { tag: "@unit" }, () => {
    expect(normalizeAXTree(nodes, { root: 9999 }).tree).toEqual([]);
  });
});

test.describe("normalizeAXTree: props and nameFrom", () => {
  test("collects properties into props, and picks the first valid name source", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree([
      node({
        nodeId: "root",
        role: { value: "textbox" },
        name: {
          value: "Email",
          sources: [

          // CDP lists every candidate source; ones that didn't supply a
          // name have no value and must be skipped.
          { type: "relatedElement" },
          { type: "placeholder", value: { value: "you@example.com" }, invalid: true },
          { type: "attribute", value: { value: "Email" } },
          ],
        },
        properties: [
          { name: "required", value: { value: true } },
          { name: "invalid", value: { value: "false" } },
        ],
        backendDOMNodeId: 1,
      }),
    ]);
    expect(tree[0]).toMatchObject({
      nameFrom: "attribute",
      props: { required: true, invalid: "false" },
    });
  });

  // Caught by Ariel's review on #168 (PR for #135/X3.2): the "Reset
  // scenario" button's real sources list a `relatedElement` candidate ahead
  // of `contents`, the one that actually produced the name. `relatedElement`
  // is neither superseded nor invalid -- CDP still lists it as a considered
  // candidate -- but it has no `value` of its own, because there's no actual
  // related element to pull a name from. The old nameFromOf picked it anyway
  // just for being first; this is the regression test for the fix.
  test("skips a non-superseded, non-invalid source that has no value of its own", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree([
      node({
        nodeId: "root",
        role: { value: "button" },
        name: {
          value: "Reset",
          sources: [
            { type: "relatedElement" }, // considered, not ruled out, but no related element -- no value
            { type: "contents", value: { value: "Reset" } }, // the one that actually won
          ],
        },
        backendDOMNodeId: 1,
      }),
    ]);
    expect(tree[0].nameFrom).toBe("contents");
  });

  // The flip side: superseded/invalid flags still rule a source out even
  // when it does carry a value -- this fix only adds a second condition, it
  // doesn't remove the first.
  test("still skips a source marked superseded or invalid, even if it has a value", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree([
      node({
        nodeId: "root",
        role: { value: "button" },
        name: {
          value: "Reset",
          sources: [
            { type: "placeholder", value: { value: "Reset" }, superseded: true },
            { type: "contents", value: { value: "Reset" } },
          ],
        },
        backendDOMNodeId: 1,
      }),
    ]);
    expect(tree[0].nameFrom).toBe("contents");
  });
});

test.describe("getCdpTree: unavailable link", () => {
  test("returns an empty result without calling CDP outside Chromium", { tag: "@unit" }, async () => {
    const result = await getCdpTree({ available: false, reason: "not Chromium" });
    expect(result).toEqual({ tree: [], ignored: new Map(), fetchMs: 0 });
  });
});

// Not @unit: these hit the real, pinned Chromium build against the live
// site, in place of the saved-JSON fixtures the first version of this PR
// used (see this file's header). Nothing here is cached to a fixture file,
// so there's nothing that can go stale against a site change — that's the
// whole point of the switch.
test.describe("getCdpTree: live site", () => {
  test("the dialog's background becomes ignored once showModal() is called", async ({ page }) => {
    await page.goto("#/disclosure/dialog?variant=accessible&delay=0");
    await page.getByTestId("trigger").waitFor();
    const link = await createCdpLink(page);
    const closed = await getCdpTree(link);

    // Same open sequence as dialog.spec.ts's openDialog(): focus the
    // trigger, then Enter.
    await page.getByTestId("trigger").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Profile settings" }).waitFor();
    const open = await getCdpTree(link);

    // The closed page can already have some ignored nodes of its own (e.g.
    // decorative content) — this isn't 0 in practice. What showModal() adds
    // is a genuinely NEW batch of ignored nodes for the background, so the
    // open state must have strictly more than the closed one started with.
    expect(open.ignored.size).toBeGreaterThan(closed.ignored.size);
  });

  test("with the menu's scenario-root as root, no node outside it is returned", async ({ page }) => {
    await page.goto("#/disclosure/menu?variant=accessible");
    await page.getByTestId("trigger").click();
    await page.getByRole("menu").waitFor();
    const link = await createCdpLink(page);
    const root = await resolveElement(link, page.getByTestId("scenario-root"));
    const { tree } = await getCdpTree(link, { root });
    expect(tree).toHaveLength(1);
    // The scenario has page chrome (a page title, instructions, etc.)
    // outside the menu; none of it should be reachable from this tree.
    const roles = new Set<string>();
    const collect = (n: (typeof tree)[number]) => {
      roles.add(n.role);
      n.children.forEach(collect);
    };
    tree.forEach(collect);
    expect(roles.has("heading")).toBe(false);
  });

  test("the broken menu variant still normalizes without throwing", async ({ page }) => {
    await page.goto("#/disclosure/menu?variant=broken");
    await page.getByTestId("trigger").click();
    // The broken variant exposes a plain list instead of a menu (that's the
    // point — see menu-aria-tree.spec.ts), so wait on that instead of role
    // "menu", which this variant never gets.
    await page.getByRole("list").waitFor();
    const link = await createCdpLink(page);
    const { tree } = await getCdpTree(link);
    expect(tree.length).toBeGreaterThan(0);
  });

  // Proves fetchMs reflects an actual CDP round trip rather than always
  // being 0 or a hardcoded value. A real round trip should never be
  // negative or missing, but it's plausible for a very fast local one to
  // round to 0ms, so this doesn't assert > 0.
  test("reports a non-negative fetch time", async ({ page }) => {
    await page.goto(`#/disclosure/menu?variant=accessible`);
    await page.getByTestId("trigger").waitFor();
    const link = await createCdpLink(page);
    const result = await getCdpTree(link);
    expect(result.fetchMs).toBeGreaterThanOrEqual(0);
    expect(result.tree.length).toBeGreaterThan(0);
  });
});
