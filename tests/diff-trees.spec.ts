// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// buildTree turns hand-written snapshot lines into AriaNode trees for these tests.
import { buildTree } from "./helpers/parse-snapshot";
// Import the tree diff helpers under test.
import { childPath, diffTrees, flattenGeneric, matchTrees, nodeLabel } from "./helpers/diff-trees";

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

test.describe("matchTrees", () => {
  // The ref is the identity, so a node that changed its name is still the same node.
  test("matches by ref even when the name changed", () => {
    const before = buildTree(`- button "Play" [ref=e2]`);
    const after = buildTree(`- button "Pause" [ref=e2]`);
    expect(matchTrees(before, after).get(before[0])).toBe(after[0]);
  });

  // A node is found by ref even under a different parent (needed for moved).
  test("matches by ref across parents", () => {
    const before = buildTree(`- list [ref=e2]:\n  - listitem [ref=e4]: x\n- list [ref=e3]`);
    const after = buildTree(`- list [ref=e2]\n- list [ref=e3]:\n  - listitem [ref=e4]: x`);
    expect(matchTrees(before, after).get(before[0].children[0])).toBe(after[1].children[0]);
  });

  // #128's case: an identical copy swapped in gets a new ref, so it must not match the old one.
  test("never pairs two nodes with different refs, even if they look the same", () => {
    const before = buildTree(`- main [ref=e2]:\n  - paragraph [ref=e3]: Saved`);
    const after = buildTree(`- main [ref=e2]:\n  - paragraph [ref=e8]: Saved`);
    expect(matchTrees(before, after).has(before[0].children[0])).toBe(false);
  });

  // A role attribute switched on the same element: no change kind for that, so no match.
  test("does not match the same ref with a different role", () => {
    const before = buildTree(`- button "Go" [ref=e2]`);
    const after = buildTree(`- link "Go" [ref=e2]`);
    expect(matchTrees(before, after).has(before[0])).toBe(false);
  });

  // Ref-free nodes pair by role + name + position under a matched parent.
  test("matches ref-free nodes by role, name and position", () => {
    const before = buildTree(`- listbox [ref=e2]:\n  - option "A"\n  - option "B"\n  - option "A"`);
    const after = buildTree(`- listbox [ref=e2]:\n  - option "B"\n  - option "A"\n  - option "A"`);
    const matches = matchTrees(before, after);
    const [a1, b, a2] = before[0].children;
    expect(matches.get(a1)).toBe(after[0].children[1]);
    expect(matches.get(b)).toBe(after[0].children[0]);
    expect(matches.get(a2)).toBe(after[0].children[2]);
  });

  // A new sibling with a ref (and the same role and name) doesn't shift the ref-free one's key.
  test("counts positions among ref-free siblings only", () => {
    const before = buildTree(`- listbox [ref=e2]:\n  - option "A"`);
    const after = buildTree(`- listbox [ref=e2]:\n  - option "A" [ref=e9]\n  - option "A"`);
    const matches = matchTrees(before, after);
    expect(matches.get(before[0].children[0])).toBe(after[0].children[1]);
    expect([...matches.values()]).not.toContain(after[0].children[0]);
  });

  // Top-level nodes hang under a virtual root that always matches.
  test("matches ref-free top-level nodes", () => {
    const before = buildTree(`- heading "Title" [level=1]\n- paragraph: old`);
    const after = buildTree(`- heading "Title" [level=1]\n- paragraph: new`);
    const matches = matchTrees(before, after);
    expect(matches.get(before[0])).toBe(after[0]);
    expect(matches.get(before[1])).toBe(after[1]);
  });

  // Ref-free children of a node that moved are still matched under it.
  test("matches ref-free children of a moved node", () => {
    const before = buildTree(`- region "A" [ref=e2]:\n  - listbox [ref=e4]:\n    - option "X"\n- region "B" [ref=e3]`);
    const after = buildTree(`- region "A" [ref=e2]\n- region "B" [ref=e3]:\n  - listbox [ref=e4]:\n    - option "X"`);
    const option = before[0].children[0].children[0];
    expect(matchTrees(before, after).get(option)).toBe(after[1].children[0].children[0]);
  });

  // A ref-free node under an unmatched parent has nothing to be matched against.
  test("does not match ref-free nodes whose parents didn't match", () => {
    const before = buildTree(`- list [ref=e2]:\n  - listitem: x`);
    const after = buildTree(`- list [ref=e9]:\n  - listitem: x`);
    expect(matchTrees(before, after).size).toBe(0);
  });
});

test.describe("diffTrees: added and removed", () => {
  // Nothing changed: nothing reported.
  test("reports nothing for identical trees", () => {
    const tree = `- main [ref=e1]:\n  - button "Save" [ref=e2]`;
    expect(diffTrees(buildTree(tree), buildTree(tree))).toEqual([]);
  });

  // A menu opening is one added subtree; its items ride along instead of being reported again.
  test("reports an added subtree once, at its root", () => {
    const before = buildTree(`- main [ref=e1]:\n  - button "Actions" [ref=e2]`);
    const after = buildTree(
      [
        `- main [ref=e1]:`,
        `  - button "Actions" [ref=e2]`,
        `  - menu "Actions" [ref=e4]:`,
        `    - menuitem "Edit" [ref=e5]`,
        `    - menuitem "Delete" [ref=e6]`,
      ].join("\n"),
    );
    const changes = diffTrees(before, after);
    expect(changes).toEqual([
      { kind: "added", path: 'main > menu "Actions"', ref: "e4", node: after[0].children[1] },
    ]);
  });

  // The menu closing: one removed, with the path from the before tree.
  test("reports a removed subtree once, at its root", () => {
    const before = buildTree(`- main [ref=e1]:\n  - menu "Actions" [ref=e4]:\n    - menuitem "Edit" [ref=e5]`);
    const after = buildTree(`- main [ref=e1]`);
    expect(diffTrees(before, after)).toEqual([
      { kind: "removed", path: 'main > menu "Actions"', ref: "e4", node: before[0].children[0] },
    ]);
  });

  // Top-level nodes have the virtual root as their parent, so they are reported too.
  test("reports added top-level nodes", () => {
    const changes = diffTrees(buildTree(`- main [ref=e1]`), buildTree(`- main [ref=e1]\n- dialog "Confirm" [ref=e9]`));
    expect(changes.map((c) => [c.kind, c.path])).toEqual([["added", 'dialog "Confirm"']]);
  });

  // A ref-free node with no partner by key is added too.
  test("reports an added ref-free node", () => {
    const before = buildTree(`- listbox [ref=e2]:\n  - option "A"`);
    const after = buildTree(`- listbox [ref=e2]:\n  - option "A"\n  - option "B"`);
    expect(diffTrees(before, after).map((c) => [c.kind, c.path])).toEqual([["added", 'listbox > option "B"']]);
  });

  // #128's input: an identical copy with a new ref is removed + added at the same path.
  test("reports an identical copy with a new ref as removed + added", () => {
    const before = buildTree(`- main [ref=e1]:\n  - paragraph [ref=e3]: Saved`);
    const after = buildTree(`- main [ref=e1]:\n  - paragraph [ref=e8]: Saved`);
    expect(diffTrees(before, after).map((c) => [c.kind, c.path, c.ref])).toEqual([
      ["added", "main > paragraph", "e8"],
      ["removed", "main > paragraph", "e3"],
    ]);
  });

  // A changed role on the same element has no kind of its own.
  test("reports a role change as removed + added", () => {
    const changes = diffTrees(buildTree(`- button "Go" [ref=e2]`), buildTree(`- link "Go" [ref=e2]`));
    expect(changes.map((c) => [c.kind, c.path])).toEqual([
      ["added", 'link "Go"'],
      ["removed", 'button "Go"'],
    ]);
  });

  // An unnamed wrapper appearing around existing content counts only by its contents (none new).
  test("flattens unnamed generic wrappers by default", () => {
    const before = buildTree(`- main [ref=e1]:\n  - button "Save" [ref=e2]`);
    const after = buildTree(`- main [ref=e1]:\n  - generic:\n    - button "Save" [ref=e2]`);
    expect(diffTrees(before, after)).toEqual([]);
    // With flattening off, the wrapper itself is a new node.
    expect(diffTrees(before, after, { flatten: false }).map((c) => [c.kind, c.path])).toEqual([
      ["added", "main > generic"],
    ]);
  });
});

test.describe("diffTrees: name, state and text changes", () => {
  // The running example: the button expands, a menu opens, the checkbox gets checked.
  test("reports state changes on pairs and the new menu once", () => {
    const before = buildTree(
      [`- main [ref=e1]:`, `  - button "Actions" [ref=e2]`, `  - checkbox "Agree" [ref=e3]`].join("\n"),
    );
    const after = buildTree(
      [
        `- main [ref=e1]:`,
        `  - button "Actions" [expanded] [ref=e2]`,
        `  - menu "Actions" [ref=e4]:`,
        `    - menuitem "Edit" [ref=e5]`,
        `  - checkbox "Agree" [checked] [ref=e3]`,
      ].join("\n"),
    );
    expect(diffTrees(before, after)).toEqual([
      {
        kind: "stateChanged",
        path: 'main > button "Actions"',
        ref: "e2",
        changes: { expanded: { before: null, after: true } },
      },
      { kind: "added", path: 'main > menu "Actions"', ref: "e4", node: after[0].children[1] },
      {
        kind: "stateChanged",
        path: 'main > checkbox "Agree"',
        ref: "e3",
        changes: { checked: { before: null, after: true } },
      },
    ]);
  });

  // Valued states keep their strings; every changed key goes into one entry.
  test("puts every changed state of a node into one stateChanged", () => {
    const changes = diffTrees(
      buildTree(`- heading "Intro" [level=2] [ref=e2]`),
      buildTree(`- heading "Intro" [level=3] [disabled] [ref=e2]`),
    );
    expect(changes).toEqual([
      {
        kind: "stateChanged",
        path: 'heading "Intro"',
        ref: "e2",
        changes: { level: { before: "2", after: "3" }, disabled: { before: null, after: true } },
      },
    ]);
  });

  // A form field's value is compared like a state, under "value".
  test("reports a changed form value as stateChanged", () => {
    const changes = diffTrees(buildTree(`- textbox "Email" [ref=e2]: a@b`), buildTree(`- textbox "Email" [ref=e2]: a@b.c`));
    expect(changes).toEqual([
      { kind: "stateChanged", path: 'textbox "Email"', ref: "e2", changes: { value: { before: "a@b", after: "a@b.c" } } },
    ]);
  });

  // A new link target (/url) is a state of the link.
  test("reports a changed link target as stateChanged", () => {
    const changes = diffTrees(
      buildTree(`- link "Docs" [ref=e2]:\n  - /url: /v1`),
      buildTree(`- link "Docs" [ref=e2]:\n  - /url: /v2`),
    );
    expect(changes.map((c) => c.kind === "stateChanged" && c.changes)).toEqual([{ url: { before: "/v1", after: "/v2" } }]);
  });

  // Play -> Pause: same element (same ref), new name.
  test("reports nameChanged for a renamed node", () => {
    const changes = diffTrees(buildTree(`- button "Play" [ref=e2]`), buildTree(`- button "Pause" [ref=e2]`));
    expect(changes).toEqual([{ kind: "nameChanged", path: 'button "Pause"', ref: "e2", before: "Play", after: "Pause" }]);
  });

  // A status message arriving is text on the status, not a new node.
  test("reports new text in an existing node as textChanged", () => {
    const changes = diffTrees(buildTree(`- status [ref=e2]`), buildTree(`- status [ref=e2]: Saved`));
    expect(changes).toEqual([{ kind: "textChanged", path: "status", ref: "e2", before: "", after: "Saved" }]);
  });

  // With flattening, text inside a new unnamed span is the parent's text, split or not.
  test("reads the same text split across unnamed spans as unchanged", () => {
    const before = buildTree(`- status [ref=e2]: Item added`);
    const after = buildTree(`- status [ref=e2]:\n  - generic: Item\n  - generic: added`);
    expect(diffTrees(before, after)).toEqual([]);
  });

  // Text directly under the virtual root has the empty path.
  test("reports top-level text changes at the root path", () => {
    const changes = diffTrees(buildTree(`- text: Loading`), buildTree(`- text: Done`));
    expect(changes).toEqual([{ kind: "textChanged", path: "", ref: undefined, before: "Loading", after: "Done" }]);
  });

  // parseLine keeps [active] out of states, so focus moving is never a stateChanged.
  test("never reports [active] moving between buttons", () => {
    const before = buildTree(`- button "One" [active] [ref=e2]\n- button "Two" [ref=e3]`);
    const after = buildTree(`- button "One" [ref=e2]\n- button "Two" [active] [ref=e3]`);
    expect(diffTrees(before, after)).toEqual([]);
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
