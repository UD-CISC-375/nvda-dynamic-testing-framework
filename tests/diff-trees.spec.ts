// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// buildTree turns hand-written snapshot lines into AriaNode trees for these tests.
import { buildTree } from "./helpers/parse-snapshot";
// Import the tree diff helpers under test.
import { childPath, flattenGeneric, nodeLabel } from "./helpers/diff-trees";

test.describe("nodeLabel and childPath", () => {
  // A named node shows its quoted name; an unnamed one shows only its role.
  test("labels a node by role and quoted name", () => {
    const nodes = buildTree(`- button "Save"\n- list`);
    expect(nodes.map((n) => nodeLabel(n, nodes))).toEqual(['button "Save"', "list"]);
  });

  // Quotes inside a name are escaped, the same way the snapshot writes them.
  test("escapes quotes in names", () => {
    const nodes = buildTree(`- heading "Say \\"hi\\"" [level=2]`);
    expect(nodeLabel(nodes[0], nodes)).toBe('heading "Say \\"hi\\""');
  });

  // [n] appears only on siblings that share role and name, and counts from 1.
  test("adds a position only when siblings share role and name", () => {
    const nodes = buildTree(`- list\n- button "Save"\n- list\n- button "Help"`);
    expect(nodes.map((n) => nodeLabel(n, nodes))).toEqual([
      "list[1]",
      'button "Save"',
      "list[2]",
      'button "Help"',
    ]);
  });

  // Top-level nodes start from the empty root path; deeper ones are joined with " > ".
  test("joins labels into the issue's path format", () => {
    const path = childPath(childPath(childPath("", "main"), 'menu "Actions"'), 'menuitem "Edit"');
    expect(path).toBe('main > menu "Actions" > menuitem "Edit"');
  });
});

// These trees are hand-written: real default-mode snapshots never contain generic nodes.
test.describe("flattenGeneric", () => {
  // Wrappers at any depth disappear and their children join the nearest real ancestor.
  test("lifts the children of unnamed generics into the parent", () => {
    const [main] = flattenGeneric(
      buildTree(
        [
          `- main:`,
          `  - generic:`,
          `    - button "Save"`,
          `    - generic:`,
          `      - button "Cancel"`,
          `  - button "Help"`,
        ].join("\n"),
      ),
    );
    expect(main.children.map((n) => [n.role, n.name])).toEqual([
      ["button", "Save"],
      ["button", "Cancel"],
      ["button", "Help"],
    ]);
  });

  // A generic with a name is kept; only unnamed ones are wrappers.
  test("keeps a named generic", () => {
    const [toolbar] = flattenGeneric(buildTree(`- generic "Toolbar":\n  - button "Save"`));
    expect(toolbar).toMatchObject({ role: "generic", name: "Toolbar" });
    expect(toolbar.children.map((n) => n.name)).toEqual(["Save"]);
  });

  // Text inside a new unnamed <span> becomes the parent's own text node.
  test("text inside an unnamed generic becomes the parent's text", () => {
    const [status] = flattenGeneric(buildTree(`- status:\n  - generic: Item added`));
    expect(status.children).toEqual([{ role: "text", value: "Item added", states: {}, children: [] }]);
  });

  // The result is a new tree; the tree passed in is left as it was.
  test("does not change the input tree", () => {
    const input = buildTree(`- main:\n  - generic:\n    - button "Save"`);
    const copy = structuredClone(input);
    flattenGeneric(input);
    expect(input).toEqual(copy);
  });
});
