// Import only the AriaNode type (the parsed tree that diffTrees compares).
import type { AriaNode } from "./parse-snapshot";

// A state or value on one side of a stateChanged; null when it wasn't there
// (JSON.stringify drops undefined, and this output has to survive JSON for #102).
export type StateValue = string | true | null;

// Fields every change has.
type ChangeBase = {
  // Where the node is, e.g. `main > menu "Actions" > menuitem "Edit"`. A display label, not an
  // identity: it can differ between trees when a sibling with the same role and name appears.
  path: string;
  // The node's ref, if it has one. The ref is the identity; X3 (#134) maps it to a CDP node.
  ref?: string;
};

// One difference between two trees. Both trees must come from the same page load: refs start
// over after a navigation, so matching refs across loads would pair unrelated nodes.
// Every change is reported here; #129 decides which ones count.
export type TreeChange = ChangeBase &
  (
    | {
        kind: "added" | "removed";
        // The raw subtree (from the after tree for added, the before tree for removed). It can
        // contain nodes that were matched elsewhere and reported as moved, so don't count what's
        // inside it. It isn't pruned because #128 compares whole subtrees to find identical copies.
        node: AriaNode;
      }
    | {
        kind: "textChanged";
        // The node's direct text, joined with single spaces.
        before: string;
        after: string;
      }
    | {
        kind: "stateChanged";
        // Only the keys that changed; a form field's value is the key "value".
        changes: Record<string, { before: StateValue; after: StateValue }>;
      }
    | {
        kind: "nameChanged";
        before: string | null;
        after: string | null;
      }
    | {
        kind: "reordered";
        // For each child matched in place, in after order: its index in the before order.
        order: number[];
      }
    | {
        kind: "moved";
        // The node's path in the before tree; `path` is where it is now.
        from: string;
      }
  );

// Label one node for a path: its role, its quoted name if it has one, and [n] (1-based) only
// when a sibling has the same role and name, so two unnamed lists read `list[1]` and `list[2]`.
export function nodeLabel(node: AriaNode, siblings: AriaNode[]): string {
  // Quote the name the way snapshots do, so quotes inside it stay readable.
  const label = node.name ? `${node.role} ${JSON.stringify(node.name)}` : node.role;
  // Siblings that would get the same label; "" and a missing name both print as no name.
  const same = siblings.filter((s) => s.role === node.role && (s.name ?? "") === (node.name ?? ""));
  // A unique label needs no position.
  if (same.length < 2) return label;
  return `${label}[${same.indexOf(node) + 1}]`;
}

// Add a child's label to its parent's path; top-level nodes have the empty root path "".
export function childPath(parentPath: string, label: string): string {
  return parentPath ? `${parentPath} > ${label}` : label;
}

// Replace each unnamed generic node with its children, so they belong to the nearest real
// ancestor (an empty <div> or <span> only groups things; only its contents count).
// Default-mode snapshots already leave out every generic, so on parseSnapshot output this
// changes nothing; it guards hand-built trees and any future Playwright output.
export function flattenGeneric(nodes: AriaNode[]): AriaNode[] {
  // flatMap lets one node turn into zero, one or many nodes in its parent's list.
  return nodes.flatMap((node) => {
    // Flatten below this node first, so wrappers nested inside wrappers are lifted too.
    const children = flattenGeneric(node.children);
    // An unnamed generic: its (already flattened) children take its place.
    if (node.role === "generic" && !node.name) return children;
    // Any other node is copied with its flattened children, so the input tree isn't changed.
    return [{ ...node, children }];
  });
}
