// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// buildTree turns hand-written snapshot lines into AriaNode trees for these tests.
import { buildTree } from "./helpers/parse-snapshot";
// Import the tree diff helpers under test.
import { flattenGeneric } from "./helpers/diff-trees";

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
