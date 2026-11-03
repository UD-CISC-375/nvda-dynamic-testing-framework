// AriaNode is the parsed tree that fingerprints are taken from.
import type { AriaNode } from "./parse-snapshot";
// flattenGeneric drops unnamed wrappers, the same way diffTrees does before comparing.
import { flattenGeneric } from "./diff-trees";
// settleKey is the string compared between polls; TreeSnapshot is one poll.
import { settleKey } from "./aria-tree";
import type { TreeSnapshot } from "./aria-tree";
// Page is where the focus-fact script runs; DomChange is watchDom's record shape.
import type { Page } from "@playwright/test";
import type { DomChange } from "./watch-dom";
// The focus record shape classify takes, and the facts in it.
import type { FocusChange, LastAction, Relation } from "./classify";

// How long to wait and how often to poll. The settle window is (stableReads - 1) polls in a
// row that read the same changed tree, each intervalMs apart (200 ms by default).
export type SettleOptions = {
  // Give up after this long with no settled change.
  timeoutMs?: number;
  // Delay between polls.
  intervalMs?: number;
  // How many identical reads in a row (the first one included) count as settled.
  stableReads?: number;
};

// The defaults, the same as waitForTreeChange's.
export const SETTLE_DEFAULTS: Required<SettleOptions> = { timeoutMs: 5000, intervalMs: 100, stableReads: 3 };

// One node reduced to what a screen reader gets: no ref, so the same page reloaded (or
// re-rendered with new refs) gives the same key.
type Print = [role: string, name: string, states: [string, string | true][], value: string | null, children: Print[]];

// Reduce one node and its subtree to a ref-free, order-stable value.
function print(node: AriaNode): Print {
  // Sort state keys, so [checked] [disabled] and [disabled] [checked] give the same print.
  const states = Object.entries(node.states).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // `?? ""`: no name and an empty name both mean "no name", as in nodeLabel and sameSubtree.
  return [node.role, node.name ?? "", states, node.value ?? null, node.children.map(print)];
}

// A key for a state's tree, compared with later entries' trees to spot a return to an
// earlier state (#130). Refs are left out because they change between loads and runs; focus
// isn't in the tree at all (focusedRef is kept apart). Wrappers are flattened first, because
// an unnamed generic only counts for its contents, the same way diffTrees sees it.
export function fingerprint(tree: AriaNode[]): string {
  return JSON.stringify(flattenGeneric(tree).map(print));
}

// Poll until the tree settles somewhere new, and return that poll. "New" means its settle key
// differs from `lastKey` (the last entry's), and settled means stableReads reads in a row got
// that same key. With no `lastKey` (the baseline), any tree that holds still counts.
// Polls where the tree is unchanged return at once if hasNewFocus() says watchDom has focus
// records the last entry didn't take, so a focus move alone still makes an entry (settling
// ignores [active], so it would never be seen otherwise). `read` is injected so the loop can
// be tested without a browser; the tracker passes snapshotTree.
export async function waitForSettled(
  read: () => Promise<TreeSnapshot>,
  lastKey: string | undefined,
  hasNewFocus: () => boolean,
  options: SettleOptions = {},
): Promise<TreeSnapshot> {
  // Options left out fall back to the defaults.
  const { timeoutMs, intervalMs, stableReads } = { ...SETTLE_DEFAULTS, ...options };
  // Absolute time after which we give up.
  const deadline = Date.now() + timeoutMs;
  // The key of the previous poll, and how many polls in a row have matched it.
  let prevKey: string | undefined;
  let sameCount = 0;
  while (Date.now() < deadline) {
    // Sleep one interval first, so a change made by the action just before has time to start.
    await new Promise((r) => setTimeout(r, intervalMs));
    // Take both snapshots of this moment.
    const now = await read();
    // Content changed while the refs were read (#126): this poll isn't one moment, so it
    // can't count towards settling. Start the count over and poll again.
    if (!now.consistent) {
      prevKey = undefined;
      sameCount = 0;
      continue;
    }
    // Compare on the settle key, which ignores [active] and [cursor=pointer].
    const key = settleKey(now);
    if (key === lastKey) {
      // Back to (or still at) the last entry's tree: nothing to settle on, but focus alone counts.
      if (hasNewFocus()) return now;
      sameCount = 0;
    } else if (key === prevKey) {
      // One more identical read of the changed tree; enough of them in a row is settled.
      if (++sameCount >= stableReads - 1) return now;
    } else {
      // The tree changed again since the last poll, so it's still moving.
      sameCount = 0;
    }
    // Remember this poll for the next comparison.
    prevKey = key;
  }
  // Nothing new settled in time: fail loudly rather than return a half-changed tree.
  throw new Error(`waitForSettled: no settled change within ${timeoutMs}ms`);
}

// What decideEntry needs to know about one settled poll.
export type EntryFacts = {
  // How many tree changes and focus records the poll brought.
  diffCount: number;
  focusCount: number;
  // classify's verdict on them.
  meaningful: boolean;
  // The most recent state whose fingerprint the new tree matches, if any.
  matchedState?: number;
  // The state the last entry belongs to, and how many states exist so far.
  currentState: number;
  stateCount: number;
};

// Whether a poll makes an entry and, if so, which state it belongs to.
export type EntryDecision = { entry: false } | { entry: true; stateIndex: number; newState: boolean };

// The one place that decides entries and states (#130), so #139 (CDP-only changes) only edits
// this function. Nothing is judged here: `meaningful` already comes from classify (#129).
export function decideEntry(facts: EntryFacts): EntryDecision {
  // The settle key changed but nothing survived the diff (e.g. only an unnamed wrapper) and
  // focus didn't move: there's nothing to record, so no entry.
  if (facts.diffCount === 0 && facts.focusCount === 0) return { entry: false };
  // Meaningful: a new state, numbered after the last one, and the one that gets scanned.
  if (facts.meaningful) return { entry: true, stateIndex: facts.stateCount, newState: true };
  // Recorded, back at an earlier state: log it on that state, which was already scanned.
  if (facts.matchedState !== undefined) return { entry: true, stateIndex: facts.matchedState, newState: false };
  // Recorded anywhere else: log it on the current state.
  return { entry: true, stateIndex: facts.currentState, newState: false };
}

// The page function watchDom calls with every record (tests/helpers/watch-dom.ts). The
// tracker wraps it, so this name must stay in step with watchDom's.
const REPORTER = "__reportDomChange";

// The facts the page measures for one focus or focusLost record, carried on the record itself.
type FocusFacts = { lastAction: LastAction | null; relation: Relation };

// A watchDom record as the tracker sees it: focus records carry the facts the wrapper added.
export type TrackedChange = DomChange & { trackerFacts?: FocusFacts };

// Whether a watchDom record is one of the focus kinds classify takes.
export function isFocusRecord(change: DomChange): boolean {
  return change.type === "focus" || change.type === "focusLost";
}

// Record the user's last pointerdown and keydown in the page, and add focus facts to each
// focus and focusLost record on its way out of watchDom. Call after watchDom has started.
// watchDom calls REPORTER synchronously inside its own focusin handler (and right after the
// removal, for focusLost), so document.activeElement here is exactly the element that just got
// focus: a later focus move can't be measured by mistake. Adds no focusin listener and
// doesn't touch the DOM, so watchDom records nothing extra.
export async function installFocusFacts(page: Page): Promise<void> {
  await page.evaluate((reporter) => {
    // The reporter is a property watchDom's exposeFunction put on window.
    const w = window as any;
    // The last pointerdown or keydown. Kept in the page: its target is a live element.
    let last: { kind: "pointerdown" | "keydown"; key?: string; target: Element | null; timeStamp: number } | null = null;
    // Capture phase on window, so a page calling stopPropagation() can't hide an action.
    window.addEventListener("pointerdown", (e) => {
      last = { kind: "pointerdown", target: e.target as Element, timeStamp: e.timeStamp };
    }, true);
    window.addEventListener("keydown", (e) => {
      // The raw key: "Tab" for Shift+Tab too.
      last = { kind: "keydown", key: e.key, target: e.target as Element, timeStamp: e.timeStamp };
    }, true);

    // Where the focused element sits relative to the action's target, in the order #129 checks.
    const relationOf = (focused: Element | null, target: Element | null) => {
      // A click on or in a <label> is a click on the control it labels.
      const label = target?.closest("label");
      const t = label?.control ?? target;
      // Nothing to compare (no focused element, or no target): there's no relation.
      if (!focused || !t) return "unrelated";
      // Focus landed on the target itself.
      if (focused === t) return "same";
      // Focus landed inside the target.
      if (t.contains(focused)) return "inside";
      // The focused element contains the target, e.g. an icon clicked inside a button.
      if (focused.contains(t)) return "contains";
      return "unrelated";
    };

    // Swap in a wrapper that measures, then hands the record on unchanged otherwise.
    const report = w[reporter];
    w[reporter] = (change: any) => {
      // Only focus records get facts; DOM changes pass straight through.
      if (change.type === "focus" || change.type === "focusLost") {
        change.trackerFacts = {
          // timeStamp and performance.now() use the same clock, so this is the gap in ms.
          lastAction: last
            ? { kind: last.kind, ...(last.key !== undefined && { key: last.key }), msBefore: performance.now() - last.timeStamp }
            : null,
          // focusLost has no focused element to compare (<body> contains everything), and with
          // no action there's no target: both are "unrelated".
          relation: change.type === "focusLost" || !last ? "unrelated" : relationOf(document.activeElement, last.target),
        };
      }
      // Hand the record on to watchDom's Node side, facts included.
      return report(change);
    };
  }, REPORTER);
}

// Turn one watchDom focus record into classify's FocusChange. The only place that builds one.
// A record without facts means the wrapper never saw it (e.g. watchDom cached its reporter,
// or the tracker was installed late): throw rather than guess.
export function toFocusChange(change: TrackedChange): FocusChange {
  if (!change.trackerFacts) {
    throw new Error(
      `tree tracker: ${change.type} record for ${change.target} has no focus facts; ` +
        `was ${REPORTER} cached, or the tracker installed after watchDom saw focus?`,
    );
  }
  // Keep only the fields classify takes.
  return {
    type: change.type as FocusChange["type"],
    target: change.target,
    oldValue: change.oldValue,
    lastAction: change.trackerFacts.lastAction,
    relation: change.trackerFacts.relation,
  };
}
