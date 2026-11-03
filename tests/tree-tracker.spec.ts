// Import Playwright's test runner and assertion library.
import { test, expect } from "@playwright/test";
// readFileSync and join load the captured snapshot pairs.
import { readFileSync } from "fs";
import { join } from "path";
// buildTree makes small hand-written trees; parseSnapshot reads the captured pairs.
import { buildTree, parseSnapshot } from "./helpers/parse-snapshot";
// Import the tracker helpers under test.
import { fingerprint } from "./helpers/tree-tracker";

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
