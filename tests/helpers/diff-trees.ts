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
        // For each stayed child, in after order: its index among the stayed children in before order.
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

// A node's own text: its direct text children joined with single spaces, with whitespace runs
// collapsed, so the same message split across different spans reads the same.
function ownText(node: AriaNode): string {
  return node.children
    .filter((c) => c.role === "text")
    .map((c) => c.value ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// A node's states plus a form field's value, which is compared like a state under "value".
function statesOf(node: AriaNode): Record<string, string | true> {
  return node.value === undefined ? node.states : { ...node.states, value: node.value };
}

// Whether two subtrees are the same apart from refs: role, name, states, value (a text node's
// text too) and children, in order. A cloned element gets a new ref on every node inside it,
// so refs are skipped at every depth; #128 uses this to find identical copies swapped in.
export function sameSubtree(a: AriaNode, b: AriaNode): boolean {
  // `?? ""`: an empty name and no name both mean "no name", as in nodeLabel.
  if (a.role !== b.role || (a.name ?? "") !== (b.name ?? "") || a.value !== b.value) return false;
  // The same state keys with the same values; the order they were written in doesn't matter.
  const keys = Object.keys(a.states);
  if (keys.length !== Object.keys(b.states).length || keys.some((k) => a.states[k] !== b.states[k])) return false;
  // The same number of children, each the same as the child at its position on the other side.
  return a.children.length === b.children.length && a.children.every((c, i) => sameSubtree(c, b.children[i]));
}

// The name, state and text changes between two partners, reported at the after node's path.
function comparePair(b: AriaNode, a: AriaNode, path: string): TreeChange[] {
  const changes: TreeChange[] = [];
  // `|| null`: an empty name and no name both mean "no name", and JSON keeps null.
  const [nameBefore, nameAfter] = [b.name || null, a.name || null];
  if (nameBefore !== nameAfter) {
    changes.push({ kind: "nameChanged", path, ref: a.ref, before: nameBefore, after: nameAfter });
  }

  // Every key on either side; a key on only one side changed from or to null.
  const [sb, sa] = [statesOf(b), statesOf(a)];
  const states: Record<string, { before: StateValue; after: StateValue }> = {};
  for (const key of new Set([...Object.keys(sb), ...Object.keys(sa)])) {
    if (sb[key] !== sa[key]) states[key] = { before: sb[key] ?? null, after: sa[key] ?? null };
  }
  // One stateChanged per node, holding every key that changed.
  if (Object.keys(states).length) changes.push({ kind: "stateChanged", path, ref: a.ref, changes: states });

  const [textBefore, textAfter] = [ownText(b), ownText(a)];
  if (textBefore !== textAfter) {
    changes.push({ kind: "textChanged", path, ref: a.ref, before: textBefore, after: textAfter });
  }
  return changes;
}

// The virtual root as a node, so top-level nodes have a parent like any other node.
function rootOf(nodes: AriaNode[]): AriaNode {
  return { role: "root", states: {}, children: nodes };
}

// Map every node under `root` to its parent; top-level nodes map to the root itself.
function parentsOf(root: AriaNode, out = new Map<AriaNode, AriaNode>()): Map<AriaNode, AriaNode> {
  for (const child of root.children) {
    out.set(child, root);
    parentsOf(child, out);
  }
  return out;
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
  // The virtual roots are real nodes here and always partners, so top-level nodes have a
  // parent pair like everyone else (for moved, reordered and top-level text).
  const [rootBefore, rootAfter] = [rootOf(before), rootOf(after)];
  const matches = matchTrees(before, after).set(rootBefore, rootAfter);
  // The same pairs looked up from the after side: after node -> before node.
  const partnerOf = new Map([...matches].map(([b, a]) => [a, b]));
  const parentBefore = parentsOf(rootBefore);
  const parentAfter = parentsOf(rootAfter);

  // Walk the before tree first: moved needs each node's old path for `from`. Removals are
  // held back so they still come out after everything from the after tree.
  const pathBefore = new Map<AriaNode, string>();
  const removed: TreeChange[] = [];
  visit(before, (n) => matches.has(n), (node, path, matched, parentMatched) => {
    pathBefore.set(node, path);
    // Same rule as added below: report a removed subtree once, at its root.
    if (!matched && parentMatched) removed.push({ kind: "removed", path, ref: node.ref, node });
  });

  // Everything that changed on one pair: moved, then its own name/state/text, then its
  // children's order.
  const pairChanges = (b: AriaNode, a: AriaNode, path: string): TreeChange[] => {
    const changes: TreeChange[] = [];
    // Where it would be if it hadn't moved: the partner of its old parent. Roots have no parent.
    if (b !== rootBefore && matches.get(parentBefore.get(b)!) !== parentAfter.get(a)) {
      changes.push({ kind: "moved", path, ref: a.ref, from: pathBefore.get(b)! });
    }
    changes.push(...comparePair(b, a, path));
    // The children that stayed under this pair (not added, removed or moved), in before order.
    const stayed = b.children.filter((c) => {
      const partner = matches.get(c);
      return partner !== undefined && parentAfter.get(partner) === a;
    });
    // The same children in after order, each as its index in `stayed`; others are skipped.
    const order = a.children
      .map((c) => stayed.findIndex((s) => matches.get(s) === c))
      .filter((i) => i !== -1);
    // Any index out of place means the order changed.
    if (order.some((n, i) => n !== i)) changes.push({ kind: "reordered", path, ref: a.ref, order });
    return changes;
  };

  // The root pair first: top-level text and order, at the empty path.
  const changes = pairChanges(rootBefore, rootAfter, "");
  visit(after, (n) => partnerOf.has(n), (node, path, matched, parentMatched) => {
    // A pair: report what changed on it.
    if (matched) changes.push(...pairChanges(partnerOf.get(node)!, node, path));
    // A new node whose parent existed before is the root of an added subtree; anything
    // below it rides along in `node` instead of being reported again.
    else if (parentMatched) changes.push({ kind: "added", path, ref: node.ref, node });
  });
  return [...changes, ...removed];
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
