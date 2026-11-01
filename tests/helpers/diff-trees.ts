// Import only the AriaNode type (the parsed tree that diffTrees compares).
import type { AriaNode } from "./parse-snapshot";

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
