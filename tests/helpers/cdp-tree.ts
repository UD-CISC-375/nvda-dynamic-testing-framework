import type { CdpLink } from "./cdp-link";

/**
 * One kept node of the normalized CDP accessibility tree (see#135). This is
 * Chromium's own tree, read through Accessibility.getFullAXTree, not
 * Playwright's ariaSnapshot — 
 */
export type CdpTreeNode = {
  backendNodeId: number;
  role: string;
  name?: string;
  description?: string;
  // required, invalid, busy, live, atomic, relevant, modal, expanded,
  // focusable, focused, and whatever else getFullAXTree reports on the node.
  // Left as a loose record rather than a narrower type: NOISE_ROLES below is
  // a deliberately short allowlist-free list (docs/how-it-works.md, Design
  // choices), and the same philosophy applies here — an unfamiliar property
  // should come through rather than be silently dropped by a type that
  // didn't anticipate it.
  props: Record<string, unknown>;
  // Where the accessible name came from (e.g. "attribute", "contents",
  // "relatedElement", "placeholder") — the first non-superseded, non-invalid
  // entry in the node's name.sources, when CDP reports one. Best-effort: this
  // isn't a field CDP returns directly, so verify it against a real capture
  // (see tests/capture-cdp-fixtures.spec.ts) before relying on exact values.
  nameFrom?: string;
  children: CdpTreeNode[];
};

/**
 * A node CDP itself marks `ignored` (not exposed to assistive tech): left out
 * of the tree, but still available here by backendNodeId with the reasons
 * CDP gave, so #136's cross-check can report "the browser hides this, the
 * snapshot doesn't" instead of the node just vanishing with no explanation.
 * Nodes with no backendDOMNodeId to key by (see NOISE_ROLES's doc comment)
 * aren't added here — there would be nothing to look them up by.
 */
export type IgnoredNode = {
  backendNodeId: number;
  role?: string;
  reasons: string[];
};

export type CdpTreeResult = {
  tree: CdpTreeNode[];
  ignored: Map<number, IgnoredNode>;
  // Wall-clock time of the Accessibility.getFullAXTree round trip alone, not
  // the tree-rebuilding work after it.
  fetchMs: number;
};

/**
 * Roles filtered out as noise, rather than kept as real nodes: inline text
 * runs (already covered by their parent's name/content) and Chromium's own
 * "none" (the ARIA presentation role — already not exposed to assistive
 * tech, and distinct from an `ignored` node: see IgnoredNode's doc comment).
 *
 * A single constant, not a narrower allowlist of roles to keep, is the
 * design choice docs/how-it-works.md's Design choices section calls out: any
 * other role — including one this list's author never anticipated — is
 * surfaced as a real node. An unexpected new role shows up as a confusing
 * node instead of silently disappearing from the tree.
 */
export const NOISE_ROLES = new Set([
  "InlineTextBox",
  "StaticText",
  "LabelText",
  "ListMarker",
  "LineBreak",
  "none",
]);

// Narrow shapes for Accessibility.getFullAXTree's raw response. Kept local
// and minimal (not the full devtools-protocol AXNode) since only these
// fields are read; the real response structurally satisfies this, and so
// does a tests/fixtures/cdp/*.json file saved straight from it (see
// tests/capture-cdp-fixtures.spec.ts and normalizeAXTree below).
export type AXValue = { value?: unknown };
export type AXProperty = { name: string; value?: AXValue };
export type AXNode = {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: AXProperty[];
  role?: AXValue;
  name?: AXValue & { sources?: { type: string; value?: AXvalue; superseded?: boolean; invalid?: boolean }[] };
  description?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

function unwrap(value: AXValue | undefined): unknown {
  return value?.value;
}

// No real DOM backing: no backendDOMNodeId, or a negative sentinel one.
function hasNoBackingNode(node: AXNode): boolean {
  return node.backendDOMNodeId === undefined || node.backendDOMNodeId < 0;
}

// The role string this node would show as a real tree node, for deciding
// noise/generic/keep — computed once per node rather than inline, since it's
// checked more than once below.
function roleOf(node: AXNode): string {
  return (unwrap(node.role) as string | undefined) ?? "";
}

function nameOf(node: AXNode): string | undefined {
  const value = unwrap(node.name) as string | undefined;
  // Chromium reports an empty string as "no name", same as undefined, for
  // the purposes of the unnamed-generic flattening rule below.
  return value ? value : undefined;
}

// First non-superseded, non-invalid name source's type, if CDP reported any
// — see CdpTreeNode.nameFrom's doc comment for the caveat on this field.
function nameFromOf(node: AXNode): string | undefined {
  return node.name?.sources?.find((s) => s.value !== undefined && !s.superseded && !s.invalid)?.type;
}

function propsOf(node: AXNode): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const prop of node.properties ?? []) props[prop.name] = unwrap(prop.value);
  return props;
}

/**
 * Builds the real, flattened children of one kept node (or of the tree's
 * top level, when called with the document root's childIds). Each raw
 * childId is resolved through `byId` and classified into exactly one of:
 *
 * - ignored (CDP's own `ignored` flag): recorded in `ignored` by
 *   backendNodeId (when it has one), then its own children are still
 *   collected and spliced in here — an ignored node doesn't necessarily mean
 *   every descendant is also ignored, so this avoids silently losing a
 *   non-ignored node nested under one that merely is.
 * - noise or an unnamed generic wrapper: not kept as a node; its children
 *   are collected and spliced in in its place instead (same mechanism for
 *   both, since an unnamed "none"/presentation-equivalent node and an
 *   unnamed "generic" wrapper both mean "treat my content as my parent's").
 * - anything else: kept as a real CdpTreeNode, with its own children built
 *   the same way, recursively.
 */
function collectChildren(
  childIds: string[] | undefined,
  byId: Map<string, AXNode>,
  ignored: Map<number, IgnoredNode>,
): CdpTreeNode[] {
  const result: CdpTreeNode[] = [];
  for (const childId of childIds ?? []) {
    const node = byId.get(childId);
    if (!node) continue; // Referenced but missing from `nodes`: nothing to build.

    const role = roleOf(node);
    const name = nameOf(node);
    const grandchildren = collectChildren(node.childIds, byId, ignored);

    if (node.ignored) {
      if (!hasNoBackingNode(node)) {
        ignored.set(node.backendDOMNodeId!, {
          backendNodeId: node.backendDOMNodeId!,
          role: role || undefined,
          reasons: (node.ignoredReasons ?? []).map((r) => r.name),
        });
      }
      result.push(...grandchildren);
      continue;
    }

    const isNoise = NOISE_ROLES.has(role) || hasNoBackingNode(node);
    const isUnnamedGeneric = role === "generic" && name === undefined;
    if (isNoise || isUnnamedGeneric) {
      result.push(...grandchildren);
      continue;
    }

    result.push({
      backendNodeId: node.backendDOMNodeId!,
      role,
      name,
      description: unwrap(node.description) as string | undefined,
      props: propsOf(node),
      nameFrom: nameFromOf(node),
      children: grandchildren,
    });
  }
  return result;
}

/**
 * Rebuilds Accessibility.getFullAXTree's raw `nodes` array into a hierarchy
 * (its order is not document order — only each node's `childIds` says who
 * its children are), applying the noise filter, the unnamed-generic
 * flattening rule, and the ignored-node lookup described on this module's
 * exports above.
 *
 * This is the pure half of getCdpTree below — no CDP session, no browser —
 * so it's exactly what tests/cdp-tree.spec.ts's offline unit tests exercise
 * directly, against `nodes` arrays saved as JSON by
 * tests/capture-cdp-fixtures.spec.ts.
 *
 * With `root` (a backendNodeId, e.g. from resolveElement — #134), only that
 * element's own subtree is kept: getFullAXTree always fetches the whole
 * page's tree (it has no scoping parameter of its own — that's
 * getPartialAXTree, which this deliberately doesn't use, per #135's
 * description), so the node whose backendDOMNodeId matches `root` is used
 * as the sole starting point instead of the page's actual root. Without
 * `root`, the whole document is kept.
 */
export function normalizeAXTree(
  nodes: AXNode[],
  options: { root?: number } = {},
): { tree: CdpTreeNode[]; ignored: Map<number, IgnoredNode> } {
  const ignored = new Map<number, IgnoredNode>();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  if (options.root !== undefined) {
    // Find the node standing for `root`, and build its subtree directly —
    // never its parent's children, so nothing outside the subtree returns.
    const rootNode = nodes.find((n) => n.backendDOMNodeId === options.root);
    if (!rootNode) return { tree: [], ignored };
    // The root itself is never noise/generic/ignored-away: it's exactly the
    // element the caller asked to resolve into a tree, by its CDP identity.
    return {
      tree: [
        {
          backendNodeId: rootNode.backendDOMNodeId!,
          role: roleOf(rootNode),
          name: nameOf(rootNode),
          description: unwrap(rootNode.description) as string | undefined,
          props: propsOf(rootNode),
          nameFrom: nameFromOf(rootNode),
          children: collectChildren(rootNode.childIds, byId, ignored),
        },
      ],
      ignored,
    };
  }

  // No root given: start from the document's own root (the one node with no
  // parent — getFullAXTree returns exactly one per frame, and iframes are
  // out of scope for #135, same as #133's epic).
  const documentRoot = nodes.find((n) => !nodes.some((other) => other.childIds?.includes(n.nodeId)));
  return {
    tree: documentRoot ? collectChildren([documentRoot.nodeId], byId, ignored) : [],
    ignored,
  };
}

/**
 * Fetches Chromium's full accessibility tree for `link`'s page via
 * Accessibility.getFullAXTree and normalizes it with normalizeAXTree (see
 * its doc comment for what `root` does and how nodes are kept/flattened).
 *
 * Returns `{ tree: [], ignored: new Map(), fetchMs: 0 }` without calling CDP
 * at all when `link` isn't available (non-Chromium) — same "skip, don't
 * throw" contract as resolveElement/resolveRefs in cdp-link.ts.
 */
export async function getCdpTree(
  link: CdpLink,
  options: { root?: number } = {},
): Promise<CdpTreeResult> {
  if (!link.available) return { tree: [], ignored: new Map(), fetchMs: 0 };

  const start = Date.now();
  const { nodes } = (await link.session.send("Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };
  const fetchMs = Date.now() - start;

  return { ...normalizeAXTree(nodes, options), fetchMs };
}
