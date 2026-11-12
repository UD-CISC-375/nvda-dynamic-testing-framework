// Unit tests for normalizeAXTree/getCdpTree (#135). Most of these need no
// browser at all: they feed hand-built or saved-JSON Accessibility.getFullAXTree
// `nodes` arrays straight into normalizeAXTree. The one live test at the
// bottom checks getCdpTree's fetchMs against a real page, since that's not
// something a saved fixture can demonstrate.
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeAXTree, getCdpTree, AXNode, IgnoredNode } from "./helpers/cdp-tree";
import { createCdpLink } from "./helpers/cdp-link";

// Reads a fixture captured by capture-cdp-fixtures.spec.ts (CAPTURE=1). If
// you're seeing ENOENT here, that capture hasn't been run yet in this
// checkout — see that file's header for the command.
function fixture(file: string): { nodes: AXNode[]; meta: { scopeBackendNodeId?: number } } {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "cdp", file), "utf8"));
}

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
            { type: "relatedElement", invalid: true },
            { type: "attribute" },
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
});

test.describe("getCdpTree: unavailable link", () => {
  test("returns an empty result without calling CDP outside Chromium", { tag: "@unit" }, async () => {
    const result = await getCdpTree({ available: false, reason: "not Chromium" });
    expect(result).toEqual({ tree: [], ignored: new Map(), fetchMs: 0 });
  });
});

test.describe("getCdpTree: real captured fixtures", () => {
  test("the dialog's background becomes ignored once showModal() is called", { tag: "@unit" }, () => {
    const closed = normalizeAXTree(fixture("dialog-closed.json").nodes);
    const open = normalizeAXTree(fixture("dialog-open.json").nodes);
    // The closed page can already have some ignored nodes of its own (e.g.
    // decorative content) — this isn't 0 in practice. What showModal() adds
    // is a genuinely NEW batch of ignored nodes for the background, so the
    // open state must have strictly more than the closed one started with.
    expect(open.ignored.size).toBeGreaterThan(closed.ignored.size);
  });

  test("with the menu's scenario-root as root, no node outside it is returned", { tag: "@unit" }, () => {
    const { nodes, meta } = fixture("menu-accessible.json");
    expect(meta.scopeBackendNodeId).toBeDefined();
    const { tree } = normalizeAXTree(nodes, { root: meta.scopeBackendNodeId });
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

  test("the broken menu's fixture still normalizes without throwing", { tag: "@unit" }, () => {
    const { tree } = normalizeAXTree(fixture("menu-broken.json").nodes);
    expect(tree.length).toBeGreaterThan(0);
  });
});

// Not @unit: hits the real site, to prove fetchMs reflects an actual CDP
// round trip rather than always being 0 or a hardcoded value. A real round
// trip should never be negative or missing, but it's plausible for a very
// fast local one to round to 0ms, so this doesn't assert > 0.
test("getCdpTree reports a non-negative fetch time from a real page", async ({ page }) => {
  await page.goto(`#/disclosure/menu?variant=accessible`);
  await page.getByTestId("trigger").waitFor();
  const link = await createCdpLink(page);
  const result = await getCdpTree(link);
  expect(result.fetchMs).toBeGreaterThanOrEqual(0);
  expect(result.tree.length).toBeGreaterThan(0);
});
