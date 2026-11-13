// AriaNode is the parsed tree that fingerprints are taken from; parseSnapshot builds it.
import { parseSnapshot } from "./parse-snapshot";
import type { AriaNode } from "./parse-snapshot";
// flattenGeneric drops unnamed wrappers, the same way diffTrees does before comparing.
import { diffTrees, flattenGeneric } from "./diff-trees";
import type { TreeChange } from "./diff-trees";
// settleKey is the string compared between polls; TreeSnapshot is one poll.
import { settleKey, snapshotTree } from "./aria-tree";
import type { TreeSnapshot } from "./aria-tree";
// Page is where the focus-fact script runs; DomChange is watchDom's record shape.
import type { Locator, Page } from "@playwright/test";
import { watchDom } from "./watch-dom";
import type { DomChange } from "./watch-dom";
// classify judges each entry; the types are its input and output shapes.
import { classify } from "./classify";
import type { Classification, FocusChange, LastAction, Relation } from "./classify";

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

// Set on window by the tracker's page script. A reload or new document clears it (and the
// listeners with it); history.pushState keeps it, along with everything else in the page.
const MARKER = "__treeTrackerInstalled";

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
  await page.evaluate(({ reporter, marker }) => {
    // The reporter is a property watchDom's exposeFunction put on window.
    const w = window as any;
    // Mark this document, so the tracker can tell when it's been replaced.
    w[marker] = true;
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
  }, { reporter: REPORTER, marker: MARKER });
}

// Throw if the page is no longer the document the tracker started on. Refs only last one page
// load, so diffing across loads would pair unrelated nodes, and the listeners are gone too.
// Doesn't re-baseline: the caller decides what a navigation means. pushState isn't caught on
// purpose: SPA navigation is an open row in the definition.
export async function assertSameDocument(page: Page): Promise<void> {
  // An evaluate during a navigation can fail outright; that's a new document too.
  const marked = await page.evaluate((marker) => (window as any)[marker] === true, MARKER).catch(() => false);
  if (!marked) {
    throw new Error("tree tracker: the page loaded a new document (reload or navigation); create a new tracker");
  }
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

// One settled change (or the baseline), as plain JSON-serializable data for reports (#102).
export type TreeEntry = {
  // Position in the history, from 0 (the baseline).
  index: number;
  // The state this entry belongs to: the one it started, or the one it was logged on.
  stateIndex: number;
  // True when this entry started its state, i.e. the state to scan. The baseline is one.
  newState: boolean;
  // The parsed tree after the change, and the focused ref (kept for reports only).
  tree: AriaNode[];
  focusedRef?: string;
  // What changed since the last entry: tree changes, then watchDom's focus records.
  diff: TreeChange[];
  focusChanges: FocusChange[];
  // classify's labels for the changes, and its verdict.
  classification: Classification;
  meaningful: boolean;
  // When the change settled (ms since the epoch).
  timestamp: number;
};

// Start watching `scope` and record a settled baseline: entry 0, state 0. `scope` only picks
// what gets snapshotted; watchDom always watches <body>, so focus moving out of the component
// (the meaningful case) is still seen. Only one watchDom can run per page, so use
// tracker.watcher instead of calling watchDom again.
export async function createTreeTracker(page: Page, scope: Locator, options: SettleOptions = {}) {
  // The tracker's settle options, with defaults filled in; next() can override them per call.
  const settle = { ...SETTLE_DEFAULTS, ...options };
  // watchDom first, so the fact wrapper has a reporter to wrap.
  const watcher = await watchDom(page, "body");
  await installFocusFacts(page);
  // Both snapshots of one moment, as every poll takes them, after checking it's still the
  // same document (so a reload fails on the next poll, not with a nonsense diff).
  const read = async () => {
    await assertSameDocument(page);
    return snapshotTree(scope);
  };
  // watchDom's focus records so far, in order.
  const focusRecords = () => watcher.changes.filter(isFocusRecord) as TrackedChange[];

  // Every entry, never deduplicated, so the history keeps the order things happened in.
  const entries: TreeEntry[] = [];
  // One fingerprint per state, by stateIndex: the tree when that state started (and was scanned).
  const states: string[] = [];
  // The settle key and tree the next change is compared against.
  let lastKey: string;
  let lastTree: AriaNode[];
  // How many focus records earlier entries took. An entry takes every record up to the moment
  // it's returned, so one arriving while the tree settles goes with that entry.
  let taken = 0;

  // Add one entry from a settled poll, if decideEntry says it makes one.
  function record(
    snap: TreeSnapshot,
    { tree, focusedRef }: ReturnType<typeof parseSnapshot>,
    diff: TreeChange[],
    focusChanges: FocusChange[],
  ): TreeEntry | undefined {
    // Whatever happens, later changes are compared against this tree.
    lastKey = settleKey(snap);
    lastTree = tree;
    // Back at an earlier state? Any earlier state counts (#130); the most recent match wins.
    // Only-previous would compare against the current state's fingerprint alone.
    const print = fingerprint(tree);
    const match = states.lastIndexOf(print);
    const matchedState = match === -1 ? undefined : match;
    // Label the changes with the definition's table (#129); a match makes tree changes recorded.
    const classification = classify({ diff, focusChanges, matchesState: matchedState !== undefined });
    // The baseline always starts state 0; every other entry goes through decideEntry.
    const decision =
      entries.length === 0
        ? ({ entry: true, stateIndex: 0, newState: true } as const)
        : decideEntry({
            diffCount: diff.length,
            focusCount: focusChanges.length,
            meaningful: classification.meaningful,
            matchedState,
            currentState: entries[entries.length - 1].stateIndex,
            stateCount: states.length,
          });
    // Nothing worth an entry: the caller keeps waiting.
    if (!decision.entry) return undefined;
    // A new state takes the next number and remembers its tree.
    if (decision.newState) states.push(print);
    const entry: TreeEntry = {
      index: entries.length,
      stateIndex: decision.stateIndex,
      newState: decision.newState,
      tree,
      ...(focusedRef !== undefined && { focusedRef }),
      diff,
      focusChanges,
      classification,
      meaningful: classification.meaningful,
      timestamp: Date.now(),
    };
    entries.push(entry);
    return entry;
  }

  // Take every focus record no entry has taken yet.
  function takeFocus(): FocusChange[] {
    // Read the list once, so a record arriving mid-way is neither lost nor taken twice.
    const all = focusRecords();
    // The new ones, as classify's FocusChange (throws if one has no facts).
    const fresh = all.slice(taken).map(toFocusChange);
    taken = all.length;
    return fresh;
  }

  // The baseline: the first tree that holds still. Focus records before it belong to page load.
  const baseline = await waitForSettled(read, undefined, () => false, settle);
  taken = focusRecords().length;
  record(baseline, parseSnapshot(baseline), [], []);

  return {
    watcher,
    // Every entry so far, oldest first (a copy, so callers can't rewrite the history).
    history: (): TreeEntry[] => [...entries],
    // Wait for the next settled change against the last entry and return its entry. Runs
    // whenever it's called, with or without a user action just before. Throws if nothing
    // settles within timeoutMs.
    async next(overrides: SettleOptions = {}): Promise<TreeEntry> {
      // This call's options: the tracker's, with any overrides on top.
      const opts = { ...settle, ...overrides };
      // One deadline for the whole call, even if some settled polls make no entry.
      const deadline = Date.now() + opts.timeoutMs;
      for (;;) {
        // Time left; out of it means nothing worth an entry happened.
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`tree tracker: no new entry within ${opts.timeoutMs}ms`);
        // Wait for a settled new tree, or for focus records on an unchanged one.
        const snap = await waitForSettled(read, lastKey, () => focusRecords().length > taken, {
          ...opts,
          timeoutMs: remaining,
        });
        // Parse once; the entry keeps this tree.
        const parsed = parseSnapshot(snap);
        // Diff against the last entry's tree (or the last settled tree that made no entry).
        const diff = diffTrees(lastTree, parsed.tree);
        // Focus records are taken after settling, so late ones go with this entry.
        const entry = record(snap, parsed, diff, takeFocus());
        // No entry (nothing survived the diff and focus didn't move): keep waiting.
        if (entry) return entry;
      }
    },
  };
}

// What createTreeTracker returns.
export type TreeTracker = Awaited<ReturnType<typeof createTreeTracker>>;
