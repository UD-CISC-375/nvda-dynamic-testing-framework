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

// List every node in a tree, parents before children.
function allNodes(nodes: AriaNode[], out: AriaNode[] = []): AriaNode[] {
  for (const node of nodes) {
    out.push(node);
    allNodes(node.children, out);
  }
  return out;
}

// Key each sibling that has no ref as [role, name, n], where n counts earlier siblings
// without refs that have the same role and name. Siblings with refs don't count, so adding
// one can't shift the keys of the others.
function keyed(nodes: AriaNode[]): Map<string, AriaNode> {
  const keys = new Map<string, AriaNode>();
  // How many ref-free siblings with each role and name have been keyed so far.
  const seen = new Map<string, number>();
  for (const node of nodes) {
    // Nodes with refs belong to the ref pass; text belongs to its parent (textChanged).
    if (node.ref !== undefined || node.role === "text") continue;
    // JSON keeps role and name apart even if a name contains any separator we might pick.
    const base = JSON.stringify([node.role, node.name ?? ""]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keys.set(JSON.stringify([node.role, node.name ?? "", n]), node);
  }
  return keys;
}

// Match the nodes of two trees from the same page load; returns before node -> after node.
// Text nodes are never matched: their text is compared on the parent instead.
export function matchTrees(before: AriaNode[], after: AriaNode[]): Map<AriaNode, AriaNode> {
  // Every after node with a ref, so a ref is found wherever it is now (moved nodes too).
  const afterByRef = new Map<string, AriaNode>();
  for (const node of allNodes(after)) if (node.ref !== undefined) afterByRef.set(node.ref, node);

  const matches = new Map<AriaNode, AriaNode>();
  // Ref pass: the same ref and the same role is the same element. A changed role (e.g. a role
  // attribute switched from button to link) has no change kind, so it stays unmatched and
  // comes out as removed + added. Different refs are never paired anywhere.
  for (const node of allNodes(before)) {
    const other = node.ref === undefined ? undefined : afterByRef.get(node.ref);
    if (other?.role === node.role) matches.set(node, other);
  }

  // Key pass: sibling lists to search for ref-free pairs. The two top-level lists act as the
  // children of a virtual root that always matches; every ref pair's children come next, so
  // ref-free nodes under a moved node are still found.
  const queue: [AriaNode[], AriaNode[]][] = [[before, after]];
  for (const [b, a] of matches) queue.push([b.children, a.children]);
  for (let i = 0; i < queue.length; i++) {
    // Same key on both sides: the same node. Only nodes without refs have keys.
    const afterByKey = keyed(queue[i][1]);
    for (const [key, node] of keyed(queue[i][0])) {
      const other = afterByKey.get(key);
      if (!other) continue;
      matches.set(node, other);
      // A new pair: its children may hold more ref-free pairs.
      queue.push([node.children, other.children]);
    }
  }
  return matches;
}

// Visit every non-text node in document order with its path, whether it has a partner in the
// other tree, and whether its parent does (top-level nodes: the virtual root always does).
// Unmatched subtrees are still entered, so nodes matched inside them (moved) are seen too.
function visit(
  nodes: AriaNode[],
  isMatched: (node: AriaNode) => boolean,
  fn: (node: AriaNode, path: string, matched: boolean, parentMatched: boolean) => void,
  parentPath = "",
  parentMatched = true,
): void {
  for (const node of nodes) {
    // Text belongs to its parent and is compared there (textChanged).
    if (node.role === "text") continue;
    const path = childPath(parentPath, nodeLabel(node, nodes));
    const matched = isMatched(node);
    fn(node, path, matched, parentMatched);
    visit(node.children, isMatched, fn, path, matched);
  }
}

// Options for diffTrees.
export type DiffOptions = {
  // Lift the children of unnamed generic wrappers into their parents first, so only a
  // wrapper's contents count. On by default.
  flatten?: boolean;
};

// Report every change between two trees, in document order of the after tree, then removals
// in document order of the before tree. Both trees must come from the same page load: refs
// start over after a navigation, so matching refs across loads would pair unrelated nodes
// (#130 guards against that). Nothing is judged here; #129 decides what counts.
export function diffTrees(
  before: AriaNode[],
  after: AriaNode[],
  { flatten = true }: DiffOptions = {},
): TreeChange[] {
  // Compare wrapper-free copies, unless the caller wants wrappers kept.
  if (flatten) {
    before = flattenGeneric(before);
    after = flattenGeneric(after);
  }
  const matches = matchTrees(before, after);
  // The after nodes that have a before partner.
  const matchedAfter = new Set(matches.values());
  const changes: TreeChange[] = [];

  // A new node whose parent existed before is the root of an added subtree; anything
  // below it rides along in `node` instead of being reported again.
  visit(after, (n) => matchedAfter.has(n), (node, path, matched, parentMatched) => {
    if (!matched && parentMatched) changes.push({ kind: "added", path, ref: node.ref, node });
  });
  // The same rule from the before side: report a removed subtree once, at its root.
  visit(before, (n) => matches.has(n), (node, path, matched, parentMatched) => {
    if (!matched && parentMatched) changes.push({ kind: "removed", path, ref: node.ref, node });
  });
  return changes;
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
