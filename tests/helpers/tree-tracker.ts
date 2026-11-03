// AriaNode is the parsed tree that fingerprints are taken from.
import type { AriaNode } from "./parse-snapshot";
// flattenGeneric drops unnamed wrappers, the same way diffTrees does before comparing.
import { flattenGeneric } from "./diff-trees";
// settleKey is the string compared between polls; TreeSnapshot is one poll.
import { settleKey } from "./aria-tree";
import type { TreeSnapshot } from "./aria-tree";

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
