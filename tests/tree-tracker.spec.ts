// Import Playwright's test runner and assertion library.
import { test, expect } from "@playwright/test";
// readFileSync and join load the captured snapshot pairs.
import { readFileSync } from "fs";
import { join } from "path";
// buildTree makes small hand-written trees; parseSnapshot reads the captured pairs.
import { buildTree, parseSnapshot } from "./helpers/parse-snapshot";
// Import the tracker helpers under test.
import {
  createTreeTracker,
  decideEntry,
  fingerprint,
  installFocusFacts,
  isFocusRecord,
  toFocusChange,
  waitForSettled,
} from "./helpers/tree-tracker";
import type { EntryFacts, TrackedChange } from "./helpers/tree-tracker";
// watchDom produces the focus records the facts are attached to.
import { watchDom } from "./helpers/watch-dom";
import type { Page } from "@playwright/test";
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

test.describe("decideEntry", () => {
  // A poll in state 1 of 2 with one tree change, unless a test overrides some fields.
  const facts = (fields: Partial<EntryFacts> = {}): EntryFacts => ({
    diffCount: 1,
    focusCount: 0,
    meaningful: false,
    currentState: 1,
    stateCount: 2,
    ...fields,
  });

  // Nothing in the diff and no focus record: no entry at all.
  test("makes no entry for an empty diff with no focus records", () => {
    expect(decideEntry(facts({ diffCount: 0 }))).toEqual({ entry: false });
  });

  // A focus record alone is still an entry (the focus-only AC).
  test("makes an entry for focus records alone", () => {
    expect(decideEntry(facts({ diffCount: 0, focusCount: 1 })).entry).toBe(true);
  });

  // Meaningful starts the next state, even when the tree matches an earlier one (focus lost
  // on the way back).
  test("starts a new state for a meaningful entry", () => {
    const expected = { entry: true, stateIndex: 2, newState: true };
    expect(decideEntry(facts({ meaningful: true }))).toEqual(expected);
    expect(decideEntry(facts({ meaningful: true, matchedState: 0 }))).toEqual(expected);
  });

  // Recorded and back at state 0: attach to state 0.
  test("attaches a recorded entry to the matched earlier state", () => {
    expect(decideEntry(facts({ matchedState: 0 }))).toEqual({ entry: true, stateIndex: 0, newState: false });
  });

  // Recorded with no match: attach to the current state.
  test("attaches a recorded entry to the current state", () => {
    expect(decideEntry(facts())).toEqual({ entry: true, stateIndex: 1, newState: false });
  });
});

test.describe("focus facts", () => {
  // Load a page, then start watchDom and the fact wrapper on it, the way the tracker will.
  async function start(page: Page, html: string) {
    await page.setContent(html);
    const watcher = await watchDom(page);
    await installFocusFacts(page);
    // The nth focus record (counting from 1), once it has arrived, as classify will get it.
    const focusRecord = async (n = 1) => {
      const records = await watcher.waitFor((cs) => cs.filter(isFocusRecord).length >= n);
      return toFocusChange(records.filter(isFocusRecord)[n - 1] as TrackedChange);
    };
    return { watcher, focusRecord };
  }

  // Clicking a button focuses it: a pointerdown just before, on the same element.
  test("click on a button → pointerdown, same", async ({ page }) => {
    const { focusRecord } = await start(page, `<button id="save">Save</button>`);
    await page.getByRole("button", { name: "Save" }).click();
    const change = await focusRecord();
    expect(change).toMatchObject({ type: "focus", target: "button#save", relation: "same" });
    expect(change.lastAction).toMatchObject({ kind: "pointerdown" });
    expect(change.lastAction!.key).toBeUndefined();
    // Measured in the same event, so a few ms at most; never negative.
    expect(change.lastAction!.msBefore).toBeGreaterThanOrEqual(0);
    expect(change.lastAction!.msBefore).toBeLessThan(100);
  });

  // The click lands on a span; the button around it gets focus.
  test("click on a span inside a button → contains", async ({ page }) => {
    const { focusRecord } = await start(page, `<button id="save"><span id="icon">★</span> Save</button>`);
    await page.locator("#icon").click();
    expect((await focusRecord()).relation).toBe("contains");
  });

  // The click lands on a plain container whose handler focuses a field inside it.
  test("click that focuses an element inside the target → inside", async ({ page }) => {
    const { focusRecord } = await start(
      page,
      `<div id="card" style="padding:20px" onclick="document.getElementById('name').focus()"><input id="name"></div>`,
    );
    // Click the padding, not the input, so the target is the container.
    await page.locator("#card").click({ position: { x: 2, y: 2 } });
    expect((await focusRecord()).relation).toBe("inside");
  });

  // Clicking a label focuses its input; the label stands for that control.
  test("click on a label → same, via label.control", async ({ page }) => {
    const { focusRecord } = await start(page, `<label for="name">Name</label> <input id="name">`);
    await page.getByText("Name").click();
    expect(await focusRecord()).toMatchObject({ target: "input#name", relation: "same" });
  });

  // The handler sends focus somewhere else: the second record is unrelated to the click.
  test("click whose handler focuses another element → unrelated", async ({ page }) => {
    const { focusRecord } = await start(
      page,
      `<button id="go" onclick="document.getElementById('other').focus()">Go</button> <button id="other">Other</button>`,
    );
    await page.getByRole("button", { name: "Go" }).click();
    expect(await focusRecord(2)).toMatchObject({ target: "button#other", relation: "unrelated" });
  });

  // Tab reports the raw key.
  test("Tab → keydown with key Tab", async ({ page }) => {
    const { focusRecord } = await start(page, `<button id="a">A</button>`);
    await page.keyboard.press("Tab");
    expect((await focusRecord()).lastAction).toMatchObject({ kind: "keydown", key: "Tab" });
  });

  // locator.focus() fires no pointerdown or keydown, so the move looks page-made.
  test("locator.focus() → lastAction null, unrelated", async ({ page }) => {
    const { focusRecord } = await start(page, `<button id="a">A</button>`);
    await page.locator("#a").focus();
    expect(await focusRecord()).toMatchObject({ lastAction: null, relation: "unrelated" });
  });

  // The clicked button removes itself: focusLost, with relation fixed at unrelated.
  test("focusLost → unrelated", async ({ page }) => {
    const { focusRecord } = await start(page, `<button id="x" onclick="this.remove()">Remove me</button>`);
    await page.getByRole("button", { name: "Remove me" }).click();
    const lost = await focusRecord(2);
    expect(lost).toMatchObject({ type: "focusLost", target: "body", oldValue: "button#x", relation: "unrelated" });
    expect(lost.lastAction).toMatchObject({ kind: "pointerdown" });
  });

  // A record the wrapper never saw fails loudly instead of getting made-up facts.
  test("toFocusChange throws on a record without facts", () => {
    const bare: TrackedChange = {
      type: "focus",
      target: "button#a",
      attributeName: null,
      oldValue: null,
      newValue: null,
      added: [],
      removed: [],
      text: null,
      inLiveRegion: false,
    };
    expect(() => toFocusChange(bare)).toThrow("has no focus facts");
  });
});

test.describe("createTreeTracker", () => {
  // The baseline is entry 0, state 0, and the first state to scan; it has nothing to diff.
  test("records the baseline as entry 0 and state 0", async ({ page }) => {
    await page.setContent(`<button>Save</button>`);
    const tracker = await createTreeTracker(page, page.locator("body"));
    const [baseline] = tracker.history();
    expect(baseline).toMatchObject({ index: 0, stateIndex: 0, newState: true, diff: [], focusChanges: [], meaningful: false });
    expect(tracker.history()).toHaveLength(1);
  });

  // A node added is meaningful: a new state. A text change after it is logged on that state.
  test("starts a new state for a meaningful entry and logs recorded ones on it", async ({ page }) => {
    await page.setContent(
      `<button onclick="document.getElementById('out').innerHTML = '<p id=msg>Saving</p>'">Save</button><div id="out"></div>`,
    );
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("button", { name: "Save" }).click();
    const added = await tracker.next();
    expect(added).toMatchObject({ index: 1, stateIndex: 1, newState: true, meaningful: true });
    expect(added.diff.map((c) => c.kind)).toEqual(["added"]);
    // The page changes on its own, with no user action: still an entry.
    await page.evaluate(() => (document.getElementById("msg")!.textContent = "Saved"));
    const text = await tracker.next();
    expect(text).toMatchObject({ index: 2, stateIndex: 1, newState: false, meaningful: false });
    expect(text.diff.map((c) => c.kind)).toEqual(["textChanged"]);
    // Entries are plain data: what's in the history survives a JSON round trip.
    expect(JSON.parse(JSON.stringify(tracker.history()))).toEqual(tracker.history());
  });

  // A focus move made after paint, while the tree is still settling, goes with the same entry:
  // no separate focus-only entry (which would look page-made and fake a new state).
  test("an entry takes focus records that arrive while the tree settles", async ({ page }) => {
    await page.setContent(`
      <button id="open">Open</button><ul id="list"></ul>
      <script>
        document.getElementById("open").onclick = () => {
          document.getElementById("list").innerHTML = '<li><a id="first" href="#">First</a></li>';
          // Like a useEffect focusing the first item after paint, but slower.
          setTimeout(() => document.getElementById("first").focus(), 150);
        };
      </script>`);
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("button", { name: "Open" }).click();
    const opened = await tracker.next();
    expect(opened.focusChanges.map((c) => c.target)).toEqual(["button#open", "a#first"]);
    // Nothing is left over for a focus-only entry.
    await expect(tracker.next({ timeoutMs: 600 })).rejects.toThrow("within 600ms");
  });
});

test.describe("createTreeTracker: returning to an earlier state", () => {
  // A panel the Open button fills and the Close button inside it empties again.
  const panel = `
    <button id="open" onclick="document.getElementById('panel').innerHTML = '<p>Details</p><button id=close>Close</button>'">Open</button>
    <div id="panel"></div>
    <script>
      document.getElementById("panel").addEventListener("click", (e) => {
        if (e.target.id === "close") document.getElementById("panel").innerHTML = "";
      });
    </script>`;

  // Open, then empty the panel with a Reset button outside it (so no focus is lost): back at state 0,
  // nothing meaningful, so the entry is logged on state 0.
  test("attaches a recorded return to the earlier state", async ({ page }) => {
    await page.setContent(panel + `<button onclick="document.getElementById('panel').innerHTML = ''">Reset</button>`);
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("button", { name: "Open" }).click();
    expect(await tracker.next()).toMatchObject({ stateIndex: 1, newState: true });
    await page.getByRole("button", { name: "Reset" }).click();
    const back = await tracker.next();
    expect(back).toMatchObject({ index: 2, stateIndex: 0, newState: false, meaningful: false });
    // The removal is still in the diff and the history; only its label changed.
    expect(back.classification.changes.find((c) => c.reason === "tree:matchesState")).toBeTruthy();
  });

  // Close removes the focused button, so focus is lost on the way back: meaningful, so a new
  // state (2) even though the tree matches state 0.
  test("starts a new state when the return is meaningful", async ({ page }) => {
    await page.setContent(panel);
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("button", { name: "Open" }).click();
    await tracker.next();
    await page.getByRole("button", { name: "Close" }).click();
    const back = await tracker.next();
    expect(back).toMatchObject({ stateIndex: 2, newState: true, meaningful: true });
    expect(back.focusChanges.map((c) => c.type)).toContain("focusLost");
  });
});

test.describe("createTreeTracker: the issue's scenarios", () => {
  // A native checkbox toggles without any DOM mutation (checked is a property, not an
  // attribute), so watchDom sees nothing but the focus; the tree still shows [checked].
  test("a checkbox click with no DOM mutation is recorded", async ({ page }) => {
    await page.setContent(`<input type="checkbox" id="agree"><label for="agree">Agree</label>`);
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("checkbox", { name: "Agree" }).click();
    const entry = await tracker.next();
    expect(entry).toMatchObject({ stateIndex: 0, newState: false, meaningful: false });
    expect(entry.diff.map((c) => c.kind)).toEqual(["stateChanged"]);
    // watchDom saw no DOM change at all, only the click's focus move.
    expect(tracker.watcher.changes.filter((c) => !isFocusRecord(c))).toEqual([]);
  });

  // Hovering shows a tooltip through CSS alone: no DOM mutation, but a node appears.
  test("a CSS-hover tooltip is meaningful", async ({ page }) => {
    await page.setContent(`
      <style>.tip { display: none; } #help:hover + .tip { display: block; }</style>
      <button id="help">Help</button><div role="tooltip" class="tip">Opens the guide</div>`);
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("button", { name: "Help" }).hover();
    const entry = await tracker.next();
    expect(entry).toMatchObject({ stateIndex: 1, newState: true, meaningful: true });
    // A tooltip is named by its text, so the path carries the name.
    expect(entry.diff).toEqual([expect.objectContaining({ kind: "added", path: 'tooltip "Opens the guide"' })]);
  });

  // The handler moves focus to an unrelated button and changes nothing else: settling ignores
  // [active], so only the focus records make this an entry, and the page made the move.
  test("a click handler moving focus elsewhere gives an empty-diff meaningful entry", async ({ page }) => {
    await page.setContent(
      `<button id="go" onclick="document.getElementById('other').focus()">Go</button> <button id="other">Other</button>`,
    );
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("button", { name: "Go" }).click();
    const entry = await tracker.next();
    expect(entry).toMatchObject({ diff: [], meaningful: true, newState: true });
    expect(entry.classification.changes.map((c) => c.reason)).toEqual(["focus:followed-click", "focus:page-moved"]);
  });
});

test.describe("createTreeTracker on Team Y's pages", () => {
  // Click a control: a person does it in the "manual" project, Playwright does it otherwise.
  // Both fire real pointerdown events, so the tracker measures them the same way.
  async function press(page: Page, manual: boolean, testId: string, prompt: string) {
    if (manual) console.log(`>>> ${prompt} in the browser window <<<`);
    else await page.getByTestId(testId).click();
  }

  // Open the menu (a new state), then close it from its button: the tree is back at the
  // baseline and nothing meaningful happened, so the closing entry is logged on state 0.
  test("menu: open is state 1, closing from the button is recorded on state 0", async ({ page }, testInfo) => {
    const manual = testInfo.project.name === "manual";
    // A person needs longer than the default to find the button.
    const wait = manual ? { timeoutMs: 90_000 } : {};
    await page.goto("#/disclosure/menu?variant=accessible");
    await expect(page.getByTestId("trigger")).toBeVisible();
    const tracker = await createTreeTracker(page, page.locator("body"));
    await press(page, manual, "trigger", "Click the menu button");
    const opened = await tracker.next(wait);
    expect(opened).toMatchObject({ stateIndex: 1, newState: true, meaningful: true });
    await press(page, manual, "trigger", "Click the menu button again to close it");
    const closed = await tracker.next(wait);
    expect(closed).toMatchObject({ stateIndex: 0, newState: false, meaningful: false });
    // Attach the history so the report shows every entry.
    await testInfo.attach("history.json", { body: JSON.stringify(tracker.history(), null, 2), contentType: "application/json" });
  });

  // The issue's "clicking X": Team Y's dialog closes with Cancel. The two variants fail
  // differently, and both are meaningful focus changes.
  for (const [variant, reason] of [
    // close() calls opener.focus() itself: the page moved focus.
    ["accessible", "focus:page-moved"],
    // The focused Cancel button is removed with the dialog: focus is lost.
    ["broken", "focus:lost"],
  ] as const) {
    test(`dialog ${variant}: Cancel gives a meaningful ${reason}`, async ({ page }, testInfo) => {
      const manual = testInfo.project.name === "manual";
      const wait = manual ? { timeoutMs: 90_000 } : {};
      await page.goto(`#/disclosure/dialog?variant=${variant}&delay=0`);
      await expect(page.getByTestId("trigger")).toBeVisible();
      const tracker = await createTreeTracker(page, page.locator("body"));
      await press(page, manual, "trigger", "Click Open profile settings");
      await tracker.next(wait);
      await press(page, manual, "cancel", "Click Cancel");
      const closed = await tracker.next(wait);
      // The focus change the issue asks about, labeled meaningful by its own row.
      const focus = closed.classification.changes.filter((c) => "type" in c.change);
      expect(focus).toContainEqual(expect.objectContaining({ reason, label: "meaningful" }));
      expect(closed.meaningful).toBe(true);
      await testInfo.attach("history.json", { body: JSON.stringify(tracker.history(), null, 2), contentType: "application/json" });
    });
  }
});

test.describe("createTreeTracker: navigation", () => {
  // A reload gives new refs and drops the listeners: fail loudly instead of diffing.
  test("next() throws after a reload", async ({ page }) => {
    await page.setContent(`<button>Save</button>`);
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.reload();
    await expect(tracker.next({ timeoutMs: 1000 })).rejects.toThrow("new document");
  });

  // pushState keeps the document (and the listeners), so the tracker carries on.
  test("next() keeps working after history.pushState", async ({ page }) => {
    await page.setContent(
      `<button aria-pressed="false" onclick="history.pushState(null, '', '#/next'); this.setAttribute('aria-pressed', 'true')">Save</button>`,
    );
    const tracker = await createTreeTracker(page, page.locator("body"));
    await page.getByRole("button", { name: "Save" }).click();
    // A state change, not a name change: a new name gives the element a new ref (Playwright).
    expect((await tracker.next()).diff.map((c) => c.kind)).toEqual(["stateChanged"]);
  });
});
