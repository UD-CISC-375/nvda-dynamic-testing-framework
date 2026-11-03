// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// readFileSync and join load the captured snapshot pairs.
import { readFileSync } from "fs";
import { join } from "path";
// buildTree makes the small subtrees that added, removed and replaced entries carry;
// parseSnapshot reads the captured pairs.
import { buildTree, parseSnapshot } from "./helpers/parse-snapshot";
// diffTrees turns the captured pairs into the diff that classify gets from the tracker.
import { diffTrees } from "./helpers/diff-trees";
// Import the classifier under test.
import { classify, FOLLOW_WINDOW_MS } from "./helpers/classify";
// Types for the hand-built changes and the expected labels.
import type { Classification, FocusChange, Label } from "./helpers/classify";
import type { TreeChange } from "./helpers/diff-trees";

// A paragraph subtree for the entries that carry one.
const paragraph = buildTree(`- paragraph [ref=e3]: Saved`)[0];

// One hand-built change of every kind, shaped the way diffTrees reports them.
const sample: Record<TreeChange["kind"], TreeChange> = {
  added: { kind: "added", path: "paragraph", ref: "e3", node: paragraph },
  removed: { kind: "removed", path: "paragraph", ref: "e3", node: paragraph },
  moved: { kind: "moved", path: "list[2] > listitem", ref: "e4", from: "list[1] > listitem" },
  replaced: { kind: "replaced", path: "paragraph", ref: "e8", beforeRef: "e3", node: paragraph },
  textChanged: { kind: "textChanged", path: "status", ref: "e5", before: "Saving", after: "Saved" },
  stateChanged: {
    kind: "stateChanged",
    path: 'checkbox "Agree"',
    ref: "e6",
    changes: { checked: { before: null, after: true } },
  },
  nameChanged: { kind: "nameChanged", path: 'button "Pause"', ref: "e2", before: "Play", after: "Pause" },
  reordered: { kind: "reordered", path: "table > rowgroup", ref: "e7", order: [1, 0] },
};

// A focus record as the tracker will pass it: a page-made move with no user action, unless
// the test overrides some fields.
function focus(fields: Partial<FocusChange> = {}): FocusChange {
  return { type: "focus", target: "button#save", oldValue: null, lastAction: null, relation: "unrelated", ...fields };
}

// The record #116 adds when the focused element is removed and focus falls to <body>.
const lost = focus({ type: "focusLost", target: "body", oldValue: "button#close" });

// The definition's rows for tree changes (#124), written out here rather than read from
// RULES, so a wrong edit to the table fails this test.
const definition: [TreeChange["kind"], Label][] = [
  ["added", "meaningful"],
  ["removed", "meaningful"],
  ["moved", "meaningful"],
  ["replaced", "meaningful"],
  ["textChanged", "recorded"],
  ["stateChanged", "recorded"],
  ["nameChanged", "recorded"],
  ["reordered", "recorded"],
];

test.describe("classify: tree changes by kind", () => {
  // One test per row of the definition table.
  for (const [kind, label] of definition) {
    test(`${kind} → ${label}`, () => {
      const result = classify({ diff: [sample[kind]] });
      expect(result.changes[0]).toMatchObject({ change: sample[kind], label, reason: `tree:${kind}` });
      // The entry follows its only change.
      expect(result.meaningful).toBe(label === "meaningful");
    });
  }

  // replaced is still deferred (#128), so its label says so.
  test("marks replaced as provisional", () => {
    expect(classify({ diff: [sample.replaced] }).changes[0].provisional).toBe(true);
  });

  // Decided rows carry no provisional key at all, so reports only show it where it matters.
  test("leaves provisional off decided rows", () => {
    const decided = definition.map(([kind]) => kind).filter((kind) => kind !== "replaced");
    for (const kind of decided) {
      expect(classify({ diff: [sample[kind]] }).changes[0]).not.toHaveProperty("provisional");
    }
  });
});

test.describe("classify: returning to an earlier state", () => {
  // Back at an earlier state, even changes that are meaningful elsewhere are only logged.
  test("records every tree change when matchesState is set", () => {
    const result = classify({ diff: Object.values(sample), matchesState: true });
    expect(result.meaningful).toBe(false);
    // Every kind gets the same row, so the report says why an `added` wasn't meaningful.
    for (const c of result.changes) expect(c).toMatchObject({ label: "recorded", reason: "tree:matchesState" });
  });

  // The matchesState row is decided, so a replaced entry loses its provisional flag there.
  test("does not mark replaced as provisional when matchesState is set", () => {
    const [c] = classify({ diff: [sample.replaced], matchesState: true }).changes;
    expect(c).not.toHaveProperty("provisional");
  });

  // matchesState: false is the same as leaving it out: each kind gets its own row.
  test("uses the kind's row when matchesState is false", () => {
    const [c] = classify({ diff: [sample.added], matchesState: false }).changes;
    expect(c).toMatchObject({ label: "meaningful", reason: "tree:added" });
  });
});

test.describe("classify: focus changes", () => {
  // The user lost their place, so the entry is meaningful even with no tree change.
  test("focusLost → meaningful", () => {
    const result = classify({ diff: [], focusChanges: [lost] });
    expect(result.changes).toEqual([{ change: lost, label: "meaningful", reason: "focus:lost" }]);
    expect(result.meaningful).toBe(true);
  });

  // No user action before it, so the page moved focus on its own.
  test("focus moved with no user action → meaningful", () => {
    const moved = focus();
    expect(classify({ diff: [], focusChanges: [moved] }).changes).toEqual([
      { change: moved, label: "meaningful", reason: "focus:page-moved" },
    ]);
  });

  // matchesState only covers tree changes: the fingerprint holds no focus, so it can't vouch for it.
  test("judges focus on its own when matchesState is set", () => {
    const result = classify({ diff: [sample.removed], focusChanges: [lost], matchesState: true });
    expect(result.changes.map((c) => [c.label, c.reason])).toEqual([
      ["recorded", "tree:matchesState"],
      ["meaningful", "focus:lost"],
    ]);
    expect(result.meaningful).toBe(true);
  });

  // Tree changes come first and focus changes after, each group in the order it came in.
  test("lists tree changes before focus changes", () => {
    const moved = focus();
    const result = classify({ diff: [sample.textChanged], focusChanges: [lost, moved] });
    expect(result.changes.map((c) => c.change)).toEqual([sample.textChanged, lost, moved]);
  });
});

test.describe("classify: focus following the user", () => {
  // The row one focus record gets.
  const reasonOf = (change: FocusChange) => classify({ diff: [], focusChanges: [change] }).changes[0].reason;

  // Tab moves focus to the next field during the key press itself.
  test("Tab between form fields → recorded", () => {
    const tabbed = focus({ target: "input#email", oldValue: "input#name", lastAction: { kind: "keydown", key: "Tab", msBefore: 3 } });
    const result = classify({ diff: [], focusChanges: [tabbed] });
    expect(result.changes[0]).toMatchObject({ label: "recorded", reason: "focus:followed-tab" });
    expect(result.meaningful).toBe(false);
  });

  // #129 gives Tab no time window, so a Tab still counts however long before the move it came.
  // The cost: if the page moves focus seconds after a Tab with no new action (delayed content),
  // that move is recorded too, not called page-moved. This test makes that visible in review.
  test("a move long after a Tab → recorded", () => {
    const later = focus({ lastAction: { kind: "keydown", key: "Tab", msBefore: 3000 } });
    expect(reasonOf(later)).toBe("focus:followed-tab");
  });

  // Clicking a focusable element focuses that element.
  test("click on the focused element → recorded", () => {
    const clicked = focus({ lastAction: { kind: "pointerdown", msBefore: 2 }, relation: "same" });
    expect(reasonOf(clicked)).toBe("focus:followed-click");
  });

  // Clicking the text <span> inside a <button> focuses the button, which contains the target.
  test("click on a span inside a button → recorded", () => {
    const clicked = focus({ lastAction: { kind: "pointerdown", msBefore: 2 }, relation: "contains" });
    expect(reasonOf(clicked)).toBe("focus:followed-click");
  });

  // Clicking a wrapper can focus an element inside it.
  test("click that focuses an element inside the target → recorded", () => {
    const clicked = focus({ lastAction: { kind: "pointerdown", msBefore: 2 }, relation: "inside" });
    expect(reasonOf(clicked)).toBe("focus:followed-click");
  });

  // The user clicks Close and the page sends focus back to the button that opened the popup:
  // not where they clicked, so the page moved it.
  test("page returns focus to the opening button after a click → meaningful", () => {
    const returned = focus({
      target: "button#open",
      oldValue: "button#close",
      lastAction: { kind: "pointerdown", msBefore: 4 },
      relation: "unrelated",
    });
    expect(reasonOf(returned)).toBe("focus:page-moved");
  });

  // Escape closes the popup and the page sends focus back to the opener: not a Tab, so the page moved it.
  test("page returns focus to the opening button after Escape → meaningful", () => {
    const returned = focus({ target: "button#open", lastAction: { kind: "keydown", key: "Escape", msBefore: 4 } });
    expect(reasonOf(returned)).toBe("focus:page-moved");
  });

  // The window includes its edge: exactly FOLLOW_WINDOW_MS still follows, one ms more doesn't.
  test("counts a click as followed up to FOLLOW_WINDOW_MS and not after", () => {
    const at = (msBefore: number) => focus({ lastAction: { kind: "pointerdown", msBefore }, relation: "same" });
    expect(reasonOf(at(FOLLOW_WINDOW_MS))).toBe("focus:followed-click");
    expect(reasonOf(at(FOLLOW_WINDOW_MS + 1))).toBe("focus:page-moved");
  });

  // Clicking non-focusable text drops focus to <body> without a focusin, and #116 doesn't report
  // it as focusLost. So classify gets no focus record and no tree change: nothing to flag.
  test("click on a non-focusable div → not meaningful", () => {
    expect(classify({ diff: [], focusChanges: [] }).meaningful).toBe(false);
  });
});

// Parse one captured snapshot pair from tests/fixtures/snapshots (recorded by
// capture-snapshots.spec.ts). Copied from diff-trees.spec.ts: importing a spec file would
// register its tests a second time.
function captured(name: string) {
  const read = (file: string) => readFileSync(join(__dirname, "fixtures", "snapshots", file), "utf8");
  return parseSnapshot({ content: read(`${name}.default.yaml`), refs: read(`${name}.ai.yaml`) }).tree;
}

// The diff between two captured pages, as the tracker would hand it to classify.
const diffOf = (before: string, after: string) => diffTrees(captured(before), captured(after));

// Each change's label and reason, in order, so a failing test shows which row applied.
const rows = (result: Classification) => result.changes.map((c) => [c.label, c.reason]);

test.describe("classify on captured pages", () => {
  // Accessible variant: the message is new text in the status role. Logged, no new state.
  test("polite status, accessible → recorded", () => {
    const result = classify({ diff: diffOf("polite-accessible-before", "polite-accessible-after") });
    expect(rows(result)).toEqual([["recorded", "tree:textChanged"]]);
    expect(result.meaningful).toBe(false);
  });

  // Broken variant: the message is text on the root after flattening. Still only text.
  test("polite status, broken → recorded", () => {
    const result = classify({ diff: diffOf("polite-broken-before", "polite-broken-after") });
    expect(rows(result)).toEqual([["recorded", "tree:textChanged"]]);
    expect(result.meaningful).toBe(false);
  });

  // Sorting reorders the rows and updates the status text: both logged on the current state.
  test("sortable table → recorded", () => {
    const result = classify({ diff: diffOf("sortable-unsorted", "sortable-sorted") });
    expect(rows(result)).toEqual([
      ["recorded", "tree:reordered"],
      ["recorded", "tree:textChanged"],
    ]);
    expect(result.meaningful).toBe(false);
  });

  // A real cloneNode swap (new ref, same content): meaningful for now, marked as not yet decided.
  test("identical copy swapped in → meaningful (provisional)", () => {
    const result = classify({ diff: diffOf("clone-before", "clone-after") });
    expect(result.changes).toMatchObject([{ label: "meaningful", reason: "tree:replaced", provisional: true }]);
    expect(result.meaningful).toBe(true);
  });

  // Tab moves focus between two buttons; the tree doesn't change at all (focus isn't a tree change).
  test("Tab between two buttons → recorded", () => {
    const tabbed = focus({
      target: "button#two",
      oldValue: "button#one",
      lastAction: { kind: "keydown", key: "Tab", msBefore: 3 },
    });
    const result = classify({ diff: diffOf("focus-one", "focus-two"), focusChanges: [tabbed] });
    expect(rows(result)).toEqual([["recorded", "focus:followed-tab"]]);
    expect(result.meaningful).toBe(false);
  });

  // Picking a menu item closes the menu, and the item that had focus goes with it.
  test("menu closes after picking an item and focus is lost → meaningful", () => {
    const dropped = focus({
      type: "focusLost",
      target: "body",
      oldValue: "li#archive",
      lastAction: { kind: "pointerdown", msBefore: 5 },
    });
    const result = classify({ diff: diffOf("menu-open", "menu-closed"), focusChanges: [dropped] });
    expect(rows(result)).toEqual([
      ["recorded", "tree:stateChanged"],
      ["meaningful", "tree:removed"],
      ["meaningful", "focus:lost"],
    ]);
    expect(result.meaningful).toBe(true);
  });

  // Escape closes the menu and the page sends focus back to the button that opened it.
  test("Escape closes the menu and the page returns focus to its button → meaningful", () => {
    const returned = focus({
      target: "button#actions-button",
      oldValue: "li#archive",
      lastAction: { kind: "keydown", key: "Escape", msBefore: 4 },
    });
    const result = classify({ diff: diffOf("menu-open", "menu-closed"), focusChanges: [returned] });
    expect(rows(result)).toContainEqual(["meaningful", "focus:page-moved"]);
    expect(result.meaningful).toBe(true);
  });

  // Closing the menu brings the page back to a state already seen: the removed menu is only logged.
  test("back to an earlier state → recorded", () => {
    const result = classify({ diff: diffOf("menu-open", "menu-closed"), matchesState: true });
    expect(rows(result)).toEqual([
      ["recorded", "tree:matchesState"],
      ["recorded", "tree:matchesState"],
    ]);
    expect(result.meaningful).toBe(false);
  });

  // The same return, but focus drops to <body> on the way: focusLost overrides matchesState,
  // which only speaks for tree changes.
  test("back to an earlier state with focus lost → meaningful", () => {
    const result = classify({ diff: diffOf("menu-open", "menu-closed"), focusChanges: [lost], matchesState: true });
    expect(rows(result)).toEqual([
      ["recorded", "tree:matchesState"],
      ["recorded", "tree:matchesState"],
      ["meaningful", "focus:lost"],
    ]);
    expect(result.meaningful).toBe(true);
  });
});

test.describe("classify: the entry", () => {
  // One meaningful change makes the whole entry meaningful, whatever else is in it.
  test("is meaningful if any change is", () => {
    const result = classify({ diff: [sample.textChanged, sample.added, sample.stateChanged] });
    expect(result.meaningful).toBe(true);
    // Every change is still labelled on its own, in the order it came in.
    expect(result.changes.map((c) => c.label)).toEqual(["recorded", "meaningful", "recorded"]);
  });

  // Only recorded changes: logged on the current state, no new state.
  test("is not meaningful when every change is recorded", () => {
    expect(classify({ diff: [sample.textChanged, sample.reordered] }).meaningful).toBe(false);
  });

  // Nothing changed: not meaningful. Whether that means "no new state" is the tracker's call.
  test("is not meaningful with no changes", () => {
    expect(classify({ diff: [] })).toEqual({ meaningful: false, changes: [] });
  });

  // The result goes into JSON reports (#102), so it must survive a round trip unchanged.
  test("is plain JSON data", () => {
    const result = classify({ diff: Object.values(sample), focusChanges: [lost, focus()] });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
