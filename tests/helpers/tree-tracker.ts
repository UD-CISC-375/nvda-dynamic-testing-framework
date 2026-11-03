// AriaNode is the parsed tree that fingerprints are taken from.
import type { AriaNode } from "./parse-snapshot";
// flattenGeneric drops unnamed wrappers, the same way diffTrees does before comparing.
import { flattenGeneric } from "./diff-trees";

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
