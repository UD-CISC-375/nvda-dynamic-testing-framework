// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// buildTree makes the small subtrees that added, removed and replaced entries carry.
import { buildTree } from "./helpers/parse-snapshot";
// Import the classifier under test.
import { classify } from "./helpers/classify";
// Types for the hand-built changes and the expected labels.
import type { Label } from "./helpers/classify";
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
    const result = classify({ diff: Object.values(sample) });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
