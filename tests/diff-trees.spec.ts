// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// readFileSync and join load the captured snapshot pairs.
import { readFileSync } from "fs";
import { join } from "path";
// buildTree turns hand-written snapshot lines into AriaNode trees for these tests.
import { buildTree, parseSnapshot } from "./helpers/parse-snapshot";
// Import the tree diff helpers under test.
import {
  childPath,
  diffTrees,
  flattenGeneric,
  matchTrees,
  mergeReplaced,
  nodeLabel,
  sameSubtree,
} from "./helpers/diff-trees";
// TreeChange types the hand-built change lists in the mergeReplaced tests.
import type { TreeChange } from "./helpers/diff-trees";

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

test.describe("sameSubtree", () => {
  // Compare the first top-level node of two hand-written trees.
  const same = (a: string, b: string) => sameSubtree(buildTree(a)[0], buildTree(b)[0]);

  // A clone gets new refs all the way down; that alone doesn't make it different.
  test("ignores refs at every depth", () => {
    const before = `- list [ref=e3]:\n  - listitem [ref=e4]:\n    - link "Docs" [ref=e5]`;
    const after = `- list [ref=e8]:\n  - listitem [ref=e9]:\n    - link "Docs" [ref=e10]`;
    expect(same(before, after)).toBe(true);
  });

  // A node with a ref and its copy without one are still the same content.
  test("ignores a ref present on only one side", () => {
    expect(same(`- paragraph [ref=e3]: Saved`, `- paragraph: Saved`)).toBe(true);
  });

  // States are compared as a set, not in the order they were written.
  test("ignores the order states were written in", () => {
    expect(same(`- button "Go" [disabled] [pressed]`, `- button "Go" [pressed] [disabled]`)).toBe(true);
  });

  // Any difference in content, at any depth, makes it a different subtree.
  test("notices a different role, name, state, value or text", () => {
    expect(same(`- button "Go"`, `- link "Go"`)).toBe(false);
    expect(same(`- button "Go"`, `- button "Stop"`)).toBe(false);
    expect(same(`- checkbox "A"`, `- checkbox "A" [checked]`)).toBe(false);
    expect(same(`- heading "T" [level=2]`, `- heading "T" [level=3]`)).toBe(false);
    expect(same(`- textbox "E": a@b`, `- textbox "E": a@b.c`)).toBe(false);
    expect(same(`- main:\n  - paragraph: Saved`, `- main:\n  - paragraph: Saving`)).toBe(false);
  });

  // Children are compared in order and by count.
  test("notices children added, removed or in a new order", () => {
    const ab = `- list:\n  - listitem: A\n  - listitem: B`;
    expect(same(ab, `- list:\n  - listitem: A`)).toBe(false);
    expect(same(ab, `- list:\n  - listitem: B\n  - listitem: A`)).toBe(false);
  });
});

// These change lists are hand-built, so each rule is tested without diffTrees in the way.
test.describe("mergeReplaced", () => {
  // One node from a one-line snapshot.
  const node = (line: string) => buildTree(line)[0];
  // The cloned paragraph: the same content, a new ref.
  const added: TreeChange = { kind: "added", path: "main > paragraph", ref: "e8", node: node(`- paragraph [ref=e8]: Saved`) };
  const removed: TreeChange = { kind: "removed", path: "main > paragraph", ref: "e3", node: node(`- paragraph [ref=e3]: Saved`) };
  // An unrelated change that must pass through untouched.
  const status: TreeChange = { kind: "textChanged", path: "status", ref: "e5", before: "", after: "Saved" };

  // The pair becomes one replaced entry where the added one was; the removed one is gone.
  test("merges an identical removed/added pair at the same path", () => {
    expect(mergeReplaced([added, status, removed])).toEqual([
      { kind: "replaced", path: "main > paragraph", ref: "e8", beforeRef: "e3", node: added.node },
      status,
    ]);
  });

  // The pair is found whichever half comes first in the list.
  test("merges the pair when the removed entry comes first", () => {
    expect(mergeReplaced([removed, added]).map((c) => c.kind)).toEqual(["replaced"]);
  });

  // An identical subtree somewhere else is a node going away and another arriving.
  test("leaves a pair at different paths alone", () => {
    const elsewhere: TreeChange = { ...added, path: "main > region > paragraph" };
    expect(mergeReplaced([elsewhere, removed])).toEqual([elsewhere, removed]);
  });

  // Different content at the same path is a real change, not a copy.
  test("leaves a pair with different subtrees alone", () => {
    const edited: TreeChange = { ...added, node: node(`- paragraph [ref=e8]: Saving`) };
    expect(mergeReplaced([edited, removed])).toEqual([edited, removed]);
  });

  // A list with nothing to pair comes back as it was.
  test("returns unpaired changes unchanged", () => {
    expect(mergeReplaced([added, status])).toEqual([added, status]);
    expect(mergeReplaced([])).toEqual([]);
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
    // With flattening off, the wrapper itself is a new node and the button moved into it.
    expect(diffTrees(before, after, { flatten: false }).map((c) => [c.kind, c.path])).toEqual([
      ["added", "main > generic"],
      ["moved", 'main > generic > button "Save"'],
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

test.describe("diffTrees: moved and reordered", () => {
  // Same ref, new parent: moved, with the old path in `from`. Paths differ only by [n].
  test("reports a node that changed parent as moved", () => {
    const before = buildTree(`- list [ref=e2]:\n  - listitem [ref=e4]: Milk\n- list [ref=e3]`);
    const after = buildTree(`- list [ref=e2]\n- list [ref=e3]:\n  - listitem [ref=e4]: Milk`);
    expect(diffTrees(before, after)).toEqual([
      { kind: "moved", path: "list[2] > listitem", ref: "e4", from: "list[1] > listitem" },
    ]);
  });

  // Moved into a brand-new container: added for the container, moved for the node. The added
  // node's payload still holds the moved node (it isn't pruned; see TreeChange).
  test("reports a node moved into a new container as added + moved", () => {
    const before = buildTree(`- main [ref=e1]:\n  - button "Save" [ref=e2]`);
    const after = buildTree(`- main [ref=e1]:\n  - dialog "Confirm" [ref=e5]:\n    - button "Save" [ref=e2]`);
    expect(diffTrees(before, after).map((c) => [c.kind, c.path])).toEqual([
      ["added", 'main > dialog "Confirm"'],
      ["moved", 'main > dialog "Confirm" > button "Save"'],
    ]);
  });

  // Moved out of a container that was removed: moved for the node, removed for the container.
  test("reports a node moved out of a removed container as moved + removed", () => {
    const before = buildTree(`- main [ref=e1]:\n  - dialog "Confirm" [ref=e5]:\n    - button "Save" [ref=e2]`);
    const after = buildTree(`- main [ref=e1]:\n  - button "Save" [ref=e2]`);
    expect(diffTrees(before, after)).toEqual([
      { kind: "moved", path: 'main > button "Save"', ref: "e2", from: 'main > dialog "Confirm" > button "Save"' },
      { kind: "removed", path: 'main > dialog "Confirm"', ref: "e5", node: before[0].children[0] },
    ]);
  });

  // Rows sorted the other way: one reordered on the parent; order gives each row's old index.
  test("reports siblings in a new order as reordered", () => {
    const before = buildTree(
      `- rowgroup [ref=e2]:\n  - row "Ann" [ref=e3]\n  - row "Bob" [ref=e4]\n  - row "Cy" [ref=e5]`,
    );
    const after = buildTree(
      `- rowgroup [ref=e2]:\n  - row "Cy" [ref=e5]\n  - row "Ann" [ref=e3]\n  - row "Bob" [ref=e4]`,
    );
    expect(diffTrees(before, after)).toEqual([{ kind: "reordered", path: "rowgroup", ref: "e2", order: [2, 0, 1] }]);
  });

  // Ref-free siblings are matched by key, so swapping them is a reorder too.
  test("reports ref-free siblings in a new order as reordered", () => {
    const before = buildTree(`- listbox [ref=e2]:\n  - option "A"\n  - option "B"`);
    const after = buildTree(`- listbox [ref=e2]:\n  - option "B"\n  - option "A"`);
    expect(diffTrees(before, after)).toEqual([{ kind: "reordered", path: "listbox", ref: "e2", order: [1, 0] }]);
  });

  // Inserting or removing a sibling shifts positions but isn't a reorder.
  test("does not report an insertion or removal as reordered", () => {
    const list = (items: string[]) => buildTree(`- list [ref=e1]:\n` + items.map((i) => `  - listitem [ref=${i}]`).join("\n"));
    expect(diffTrees(list(["e2", "e3"]), list(["e9", "e2", "e3"])).map((c) => c.kind)).toEqual(["added"]);
    expect(diffTrees(list(["e2", "e3"]), list(["e3"])).map((c) => c.kind)).toEqual(["removed"]);
  });

  // Top-level nodes are children of the virtual root, so their order is checked at "".
  test("reports reordered top-level nodes at the root path", () => {
    const changes = diffTrees(buildTree(`- banner [ref=e1]\n- main [ref=e2]`), buildTree(`- main [ref=e2]\n- banner [ref=e1]`));
    expect(changes).toEqual([{ kind: "reordered", path: "", ref: undefined, order: [1, 0] }]);
  });
});

test.describe("diffTrees: known problems", () => {
  // Known mergeRefs bug (X2.2, not fixed yet): AI mode lists the contents of an aria-hidden
  // wrapper with no marker, and an unnamed real node can take a hidden node's ref; every later
  // unnamed sibling with that role then shifts by one. Harmless while the hidden content stays,
  // but when it goes away the refs shift back, and matching by ref reports false changes
  // (including meaningful removed + added) on a page where nothing visible changed.
  // Today this reports textChanged "Two" -> "One", added Two (e4) and removed One (e2).
  // Change test.fixme back to test once mergeRefs is fixed.
  test.fixme("hidden content disappearing does not shift refs and report false changes", () => {
    // Before: an unnamed hidden paragraph comes first in AI mode, so "One" takes its ref (e2).
    const before = parseSnapshot({
      content: `- main:\n  - paragraph: One\n  - paragraph: Two`,
      refs: `- main [ref=e1]:\n  - paragraph [ref=e2]: HIDDEN\n  - paragraph [ref=e3]: One\n  - paragraph [ref=e4]: Two`,
    });
    // After: the hidden paragraph is gone, so "One" gets its real ref (e3) back.
    const after = parseSnapshot({
      content: `- main:\n  - paragraph: One\n  - paragraph: Two`,
      refs: `- main [ref=e1]:\n  - paragraph [ref=e3]: One\n  - paragraph [ref=e4]: Two`,
    });
    expect(diffTrees(before.tree, after.tree)).toEqual([]);
  });

  // Known diffTrees bug (X2.3, not fixed yet): nodes without a ref are matched by keyed(), whose
  // key is role + name + position among ref-free siblings with the same role and name. Inserting
  // one at the front shifts every later key by one, so each old node pairs with its new left
  // neighbour. Today this reports textChanged "one" -> "new" at [1], textChanged "two" -> "one"
  // at [2] and added at [3], instead of one added at [1]; #129 would then call a real addition
  // recorded instead of meaningful.
  // Change test.fixme back to test once this is fixed. See #169.
  test.fixme("a ref-free sibling inserted at the front is reported as added, not as shifted text", () => {
    // Before: two listitems with the same role and name and no refs.
    const before = parseSnapshot({
      content: `- list:\n  - listitem "Row": one\n  - listitem "Row": two`,
      refs: `- list [ref=e1]:\n  - listitem "Row": one\n  - listitem "Row": two`,
    });
    // After: a third one with the same role and name is inserted at the front.
    const after = parseSnapshot({
      content: `- list:\n  - listitem "Row": new\n  - listitem "Row": one\n  - listitem "Row": two`,
      refs: `- list [ref=e1]:\n  - listitem "Row": new\n  - listitem "Row": one\n  - listitem "Row": two`,
    });
    // Only the new first item is a change; "one" and "two" are untouched.
    expect(diffTrees(before.tree, after.tree)).toEqual([
      { kind: "added", path: 'list > listitem "Row"[1]', node: after.tree[0].children[0] },
    ]);
  });
});

// Parse one captured snapshot pair from tests/fixtures/snapshots. These were recorded from
// real pages by capture-snapshots.spec.ts (CAPTURE=1); re-record them there, not by hand.
function captured(name: string) {
  const read = (file: string) => readFileSync(join(__dirname, "fixtures", "snapshots", file), "utf8");
  return parseSnapshot({ content: read(`${name}.default.yaml`), refs: read(`${name}.ai.yaml`) }).tree;
}

test.describe("diffTrees on captured pages", () => {
  // Opening the menu: the button's state changes and one menu subtree is added.
  test("menu opens", () => {
    const after = captured("menu-open");
    const changes = diffTrees(captured("menu-closed"), after);
    expect(changes).toEqual([
      {
        kind: "stateChanged",
        path: 'button "Actions"',
        ref: "e3",
        changes: { expanded: { before: null, after: true } },
      },
      { kind: "added", path: 'menu "Actions"', ref: "e9", node: after[1] },
    ]);
    // The four items ride along inside the menu instead of being reported one by one.
    expect(after[1].children.map((n) => n.name)).toEqual(["Duplicate", "Rename", "Archive", "Delete"]);
  });

  // Sorting by name: the data rows are reordered (each number is a row's old position),
  // and the status announces the sort. aria-sort isn't in the snapshot, so no stateChanged.
  test("sortable table → reordered", () => {
    expect(diffTrees(captured("sortable-unsorted"), captured("sortable-sorted"))).toEqual([
      { kind: "reordered", path: 'table "Employees" > rowgroup[2]', ref: "e13", order: [2, 1, 0, 3] },
      { kind: "textChanged", path: "status", ref: "e30", before: "", after: "Sorted by Name, ascending" },
    ]);
  });

  // Accessible variant: the message is text inside the status role.
  test("polite status, accessible → textChanged", () => {
    expect(diffTrees(captured("polite-accessible-before"), captured("polite-accessible-after"))).toEqual([
      {
        kind: "textChanged",
        path: "status",
        ref: "e3",
        before: "",
        after: "Item added to cart. 1 item in cart.",
      },
    ]);
  });

  // Broken variant: the message is in an unnamed <div>, so after flattening it is text on the
  // nearest real ancestor. Inside this capture's scope (scenario-root) there is none, so that's
  // the root, path "". Still textChanged, like the accessible variant, not a new node.
  test("polite status, broken → textChanged", () => {
    expect(diffTrees(captured("polite-broken-before"), captured("polite-broken-after"))).toEqual([
      { kind: "textChanged", path: "", ref: undefined, before: "", after: "Item added to cart. 1 item in cart." },
    ]);
  });

  // Both unnamed lists gain an identical "Milk" item; only the path ([1] vs [2]) tells
  // which list each one went into.
  test("two lists gain an item with the same text, told apart by path", () => {
    const after = captured("lists-after");
    expect(diffTrees(captured("lists-before"), after)).toEqual([
      { kind: "added", path: "main > list[1] > listitem[2]", ref: "e8", node: after[0].children[0].children[1] },
      { kind: "added", path: "main > list[2] > listitem[2]", ref: "e9", node: after[0].children[1].children[1] },
    ]);
  });

  // Checking the box changes one state on an existing node.
  test("checkbox → stateChanged", () => {
    expect(diffTrees(captured("checkbox-before"), captured("checkbox-after"))).toEqual([
      {
        kind: "stateChanged",
        path: 'main > checkbox "Agree"',
        ref: "e4",
        changes: { checked: { before: null, after: true } },
      },
    ]);
  });

  // Real AI-mode output marks the focused button [active], and the mark moves with focus.
  // Focus isn't a tree change (it comes from watchDom), so neither move is reported.
  test("focus moving between two buttons → no change", () => {
    expect(diffTrees(captured("focus-body"), captured("focus-one"))).toEqual([]);
    expect(diffTrees(captured("focus-one"), captured("focus-two"))).toEqual([]);
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
