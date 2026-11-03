// Import Playwright's test runner and assertion library.
import { test, expect } from "@playwright/test";
// readFileSync and join load the captured snapshot pairs.
import { readFileSync } from "fs";
import { join } from "path";
// buildTree makes small hand-written trees; parseSnapshot reads the captured pairs.
import { buildTree, parseSnapshot } from "./helpers/parse-snapshot";
// Import the tracker helpers under test.
import { fingerprint, waitForSettled } from "./helpers/tree-tracker";
// settleKey gives the last entry's key that waitForSettled compares against.
import { settleKey } from "./helpers/aria-tree";
import type { TreeSnapshot } from "./helpers/aria-tree";

// Parse one captured pair from tests/fixtures/snapshots into a tree.
function captured(name: string) {
  // Each pair is <name>.default.yaml (content) and <name>.ai.yaml (refs).
  const read = (mode: string) => readFileSync(join(__dirname, "fixtures", "snapshots", `${name}.${mode}.yaml`), "utf8");
  return parseSnapshot({ content: read("default"), refs: read("ai") }).tree;
}

test.describe("fingerprint", () => {
  // The same page after a reload gets new refs; the fingerprint must not see them.
  test("ignores refs", () => {
    const before = buildTree(`- button "Save" [ref=e2]\n- list [ref=e3]:\n  - listitem [ref=e4]: One`);
    const after = buildTree(`- button "Save" [ref=f1e2]\n- list [ref=f1e7]:\n  - listitem [ref=f1e9]: One`);
    expect(fingerprint(after)).toBe(fingerprint(before));
  });

  // The order states are written in doesn't change what the node is.
  test("ignores the order of states", () => {
    const a = buildTree(`- checkbox "Agree" [checked] [disabled]`);
    const b = buildTree(`- checkbox "Agree" [disabled] [checked]`);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  // An unnamed wrapper only groups things, so adding one doesn't make a different state.
  test("ignores unnamed generic wrappers", () => {
    const bare = buildTree(`- button "Save"\n- button "Help"`);
    const wrapped = buildTree(`- generic:\n  - button "Save"\n  - button "Help"`);
    expect(fingerprint(wrapped)).toBe(fingerprint(bare));
  });

  // A state change is a different tree, so it's not a return to the earlier state.
  test("tells states and values apart", () => {
    const off = buildTree(`- checkbox "Agree"`);
    const on = buildTree(`- checkbox "Agree" [checked]`);
    expect(fingerprint(on)).not.toBe(fingerprint(off));
  });

  // The captured menu: open and closed are different states, and each matches itself.
  test("tells the open and closed menu apart", () => {
    expect(fingerprint(captured("menu-open"))).not.toBe(fingerprint(captured("menu-closed")));
    expect(fingerprint(captured("menu-closed"))).toBe(fingerprint(captured("menu-closed")));
  });
});

// A fake poll of a one-button page; `consistent` is false for a read the page changed during.
function snap(name: string, consistent = true): TreeSnapshot {
  return { content: `- button "${name}"`, refs: `- button "${name}" [ref=e1]`, consistent };
}

// A fake snapshotTree that returns these polls in order, then keeps returning the last one.
// `count` says how many polls were taken.
function reads(...polls: TreeSnapshot[]) {
  const reader = { count: 0, read: async () => polls[Math.min(reader.count++, polls.length - 1)] };
  return reader;
}

// No sleeping between fake polls; a short timeout so the failing case doesn't hang.
const fast = { intervalMs: 0, timeoutMs: 500 };
// No focus records waiting.
const noFocus = () => false;

test.describe("waitForSettled", () => {
  // The last entry's tree, which every test below starts from.
  const lastKey = settleKey(snap("Open"));

  // Three identical reads of the new tree in a row (the default stableReads) settle it.
  test("settles after stableReads identical reads of a changed tree", async () => {
    const r = reads(snap("Open"), snap("Close"), snap("Close"), snap("Close"));
    const settled = await waitForSettled(r.read, lastKey, noFocus, fast);
    expect(settled.content).toBe(`- button "Close"`);
    expect(r.count).toBe(4);
  });

  // A tree still moving restarts the count each time it changes.
  test("restarts the count when the tree changes again", async () => {
    const r = reads(snap("A"), snap("A"), snap("B"), snap("B"), snap("B"));
    const settled = await waitForSettled(r.read, lastKey, noFocus, fast);
    expect(settled.content).toBe(`- button "B"`);
    expect(r.count).toBe(5);
  });

  // A poll whose content changed while the refs were read isn't one moment: it breaks the run
  // of identical reads, even when its content looks the same (#126).
  test("does not count an inconsistent poll towards settling", async () => {
    const r = reads(snap("Close"), snap("Close", false), snap("Close"), snap("Close"), snap("Close"));
    await waitForSettled(r.read, lastKey, noFocus, fast);
    expect(r.count).toBe(5);
  });

  // The tree never left the last entry's, but focus moved: return that poll straight away.
  test("returns an unchanged tree at once when focus records are waiting", async () => {
    const r = reads(snap("Open"));
    const settled = await waitForSettled(r.read, lastKey, () => true, fast);
    expect(settled.content).toBe(`- button "Open"`);
    expect(r.count).toBe(1);
  });

  // The baseline has no last entry, so the first tree that holds still is it.
  test("settles on any still tree when there is no last key", async () => {
    const r = reads(snap("Open"));
    await waitForSettled(r.read, undefined, noFocus, fast);
    expect(r.count).toBe(3);
  });

  // Nothing changes and nothing focuses: fail with a message naming the timeout.
  test("throws when nothing settles in time", async () => {
    const r = reads(snap("Open"));
    await expect(waitForSettled(r.read, lastKey, noFocus, { intervalMs: 5, timeoutMs: 50 })).rejects.toThrow(
      "no settled change within 50ms",
    );
  });
});
