// crossCheck (#136): compares one settled poll's merged snapshot tree (#126)
// with Chromium's own accessibility tree for the same scope (#135) and
// reports two kinds of mismatch between them. It is a pure function -- no
// CDP session, no browser -- exactly like normalizeAXTree (#135) and
// diffTrees/classify (#127/#129): all the I/O (snapshotTree, getCdpTree,
// resolveRefs) happens before this is called, and the caller is responsible
// for passing a `tree` and `cdpTree` that were both scoped to the same
// element (e.g. the tracker's `scope`) -- that's what makes "nodes outside
// the tracker's scope are never reported" true here: this never walks
// anything the caller didn't already hand it.
//
// It doesn't judge the mismatches it finds (#129's job, same as diffTrees);
// it only reports them.
import type { AriaNode } from "./parse-snapshot";
import { nodeLabel, childPath } from "./diff-trees";
import type { AXNode, CdpTreeNode, IgnoredNode } from "./cdp-tree";
import type { CdpLink } from "./cdp-link";

// Chromium hides an element (it's in `cdpTree.ignored`, or missing from the
// surfaced tree, see below), but the snapshot still lists it.
export type HiddenByBrowser = {
  kind: "hiddenByBrowser";
  // Same format as #127's TreeChange.path (nodeLabel + childPath), built by
  // walking the SNAPSHOT tree, since that's the side this mismatch is about.
  path: string;
  ref?: string;
  // Chromium's own ignoredReasons for this node, verbatim (e.g.
  // "inertElement", "ariaHiddenElement", "activeModalDialog", ...) --
  // crossCheck never renames or guesses at these.
  reasons: string[];
};

// Chromium exposes a node that's named or focusable, and no snapshot node
// stands for it (directly by ref, or by role+name under a matched parent --
// see collectStandIns below).
export type MissingFromSnapshot = {
  kind: "missingFromSnapshot";
  // Built the same way as HiddenByBrowser's path, but by walking the CDP
  // tree instead (see cdpNodeLabel below -- nodeLabel itself is pinned to
  // AriaNode, which CdpTreeNode doesn't structurally match).
  path: string;
  backendNodeId: number;
  role: string;
  name?: string;
};

export type CrossCheckMismatch = HiddenByBrowser | MissingFromSnapshot;

// Labels one CdpTreeNode exactly the way diff-trees.ts's nodeLabel labels an
// AriaNode (role, quoted name, "[n]" only when a sibling shares both), so a
// missingFromSnapshot path reads the same as #127's paths. Not a call to
// nodeLabel itself: its parameter type is AriaNode (ref, states, value and
// all), and CdpTreeNode doesn't have those -- only role, name and children
// are read here, which both types carry, so this is kept as its own tiny
// copy rather than forcing CdpTreeNode to fake an AriaNode shape.
function cdpNodeLabel(node: CdpTreeNode, siblings: CdpTreeNode[]): string {
  const label = node.name ? `${node.role} ${JSON.stringify(node.name)}` : node.role;
  const same = siblings.filter((s) => s.role === node.role && (s.name ?? "") === (node.name ?? ""));
  if (same.length < 2) return label;
  return `${label}[${same.indexOf(node) + 1}]`;
}

// Every node of a CDP tree, keyed by backendNodeId, for O(1) lookup below.
// Exported so resolveMissingReasons (below) can build the same index the
// pure crossCheck() does, without duplicating this walk.
export function indexByBackendId(nodes: CdpTreeNode[], out = new Map<number, CdpTreeNode>()): Map<number, CdpTreeNode> {
  for (const node of nodes) {
    out.set(node.backendNodeId, node);
    indexByBackendId(node.children, out);
  }
  return out;
}

// Every backendNodeId that some snapshot node "stands for" (#136's own
// phrase): directly, through a ref that resolves via refMap, or -- for a
// snapshot node with no ref at all -- by falling back to role+name under
// the nearest ancestor pair both sides already agree on.
//
// A snapshot node has no ref in exactly the cases parse-snapshot.ts's
// mergeRefs already documents: <option> lines (AI mode never assigns them
// one) and a real unnamed node that mergeRefs's ref-shift limitation skipped
// over. Neither can be resolved through refMap, so this is the only way to
// keep them from being reported as missingFromSnapshot. It's a best-effort
// match (first unclaimed sibling with the same role and name under the
// matched parent) rather than a real identity, since there's nothing more
// reliable to go on here -- fine for crossCheck's purposes, since it only
// ever SUPPRESSES a possible missingFromSnapshot report, never creates a
// hiddenByBrowser one.
function collectStandIns(
  nodes: AriaNode[],
  siblingCdp: CdpTreeNode[] | undefined,
  refMap: Map<string, number>,
  cdpById: Map<number, CdpTreeNode>,
  standFor: Set<number>,
): void {
  for (const node of nodes) {
    // Text belongs to its parent's content, not to any CDP node of its own.
    if (node.role === "text") continue;

    let matched: CdpTreeNode | undefined;
    if (node.ref !== undefined) {
      const backendNodeId = refMap.get(node.ref);
      if (backendNodeId !== undefined) {
        standFor.add(backendNodeId);
        matched = cdpById.get(backendNodeId);
      }
    } else if (siblingCdp) {
      matched = siblingCdp.find(
        (c) => !standFor.has(c.backendNodeId) && c.role === node.role && (c.name ?? "") === (node.name ?? ""),
      );
      if (matched) standFor.add(matched.backendNodeId);
    }
    // Recurse with the matched pair's CDP children as the new sibling list,
    // so a ref-less grandchild (another <option>, say) is matched under the
    // right parent too. With no matched pair, there's nothing to fall back
    // to below this node either.
    collectStandIns(node.children, matched?.children, refMap, cdpById, standFor);
  }
}

// Whether a CDP node is the kind missingFromSnapshot cares about at all:
// named, or focusable (CDP's own "focusable" AX property). An unnamed,
// unfocusable node (most "generic" layout wouldn't even reach here --
// normalizeAXTree already flattened those -- but a named-in-neither-sense
// structural role like an anonymous "group" could) has nothing a snapshot
// reader would miss, so it's never reported even when nothing stands for it.
function isEligible(node: CdpTreeNode): boolean {
  return Boolean(node.name) || node.props.focusable === true;
}

// Chromium always builds a MenuListPopup node for a native <select>'s own
// dropdown -- listing its <option>s -- even while the dropdown is closed;
// that's how the native widget is implemented internally, not something any
// snapshot (or a screen reader) ever walks into while it's collapsed. #136's
// AC calls this out by name ("a native <select> with options... -> no
// missingFromSnapshot for the options"), confirmed against a real capture:
// the whole subtree is skipped here, not just suppressed by a standFor
// entry, since nothing in a snapshot could ever stand for it.
const NATIVE_WIDGET_INTERNAL_ROLES = new Set(["MenuListPopup"]);

function walkMissing(
  nodes: CdpTreeNode[],
  parentPath: string,
  standFor: Set<number>,
  out: MissingFromSnapshot[],
): void {
  for (const node of nodes) {
    const path = childPath(parentPath, cdpNodeLabel(node, nodes));
    if (NATIVE_WIDGET_INTERNAL_ROLES.has(node.role)) continue;
    if (isEligible(node) && !standFor.has(node.backendNodeId)) {
      out.push({
        kind: "missingFromSnapshot",
        path,
        backendNodeId: node.backendNodeId,
        role: node.role,
        ...(node.name !== undefined && { name: node.name }),
      });
    }
    // Checked independently of whether `node` itself was reported: a node
    // that's missing can still have children that aren't (and vice versa).
    walkMissing(node.children, path, standFor, out);
  }
}

// Whether any node in this snapshot subtree resolves (via refMap) to a
// backendNodeId that's actually kept in cdpTree.tree. Used to tell a truly
// hidden subtree apart from a merely-ignored WRAPPER whose content Chromium
// still exposes -- confirmed against a real capture: a table's rowgroup
// shows up in `ignored` (reason "uninteresting", not any hidden-from-AT
// reason), while its row is exposed directly as the table's own child, via
// the exact same ignored-node child-promotion normalizeAXTree already does
// for the kept tree (collectChildren, cdp-tree.ts). That's the AC's own
// "structural node whose content is still exposed" case, just reached
// through `ignored` instead of a missing AXNode entirely.
function hasExposedDescendant(
  nodes: AriaNode[],
  refMap: Map<string, number>,
  cdpById: Map<number, CdpTreeNode>,
): boolean {
  for (const node of nodes) {
    const backendNodeId = node.ref !== undefined ? refMap.get(node.ref) : undefined;
    if (backendNodeId !== undefined && cdpById.has(backendNodeId)) return true;
    if (hasExposedDescendant(node.children, refMap, cdpById)) return true;
  }
  return false;
}

function walkHidden(
  nodes: AriaNode[],
  parentPath: string,
  refMap: Map<string, number>,
  cdpById: Map<number, CdpTreeNode>,
  ignored: Map<number, IgnoredNode>,
  out: HiddenByBrowser[],
): void {
  for (const node of nodes) {
    if (node.role === "text") continue;
    const path = childPath(parentPath, nodeLabel(node, nodes));

    if (node.ref !== undefined) {
      const backendNodeId = refMap.get(node.ref);
      // A backendNodeId that IS in the kept tree is exposed -- nothing to
      // report, whatever else is true. One that resolveRefs couldn't
      // resolve at all (a stale ref) can't be judged either way, so it's
      // skipped rather than guessed at.
      if (backendNodeId !== undefined && !cdpById.has(backendNodeId)) {
        const ig = ignored.get(backendNodeId);
        if (ig && !hasExposedDescendant(node.children, refMap, cdpById)) {
          out.push({ kind: "hiddenByBrowser", path, ref: node.ref, reasons: ig.reasons });
          // Reported once, at its root: a subtree's descendants are
          // presumed hidden along with it, so they aren't walked (and
          // separately reported) here too.
          continue;
        }
        // Either not in the ignored map at all (Chromium's full tree has no
        // AXNode whatsoever for this backendNodeId), or it IS ignored but
        // at least one descendant is still exposed elsewhere: both are the
        // AC's "structural node whose content Chromium still exposes" case
        // (the rowgroup example), not something actually hidden from
        // assistive tech, so neither is reported. Still walk this node's
        // children below either way: content being exposed elsewhere says
        // nothing about whether one specific descendant is independently
        // hidden.
      }
    }
    walkHidden(node.children, path, refMap, cdpById, ignored, out);
  }
}

/**
 * Compares `tree` (a settled poll's merged snapshot tree, e.g. a
 * TreeTracker entry's `.tree` -- #126) against `cdpTree` (Chromium's own
 * tree for the same scope, from getCdpTree/normalizeAXTree -- #135) using
 * `refMap` (snapshot ref -> CDP backendNodeId, from resolveRefs -- #134) to
 * line the two up, and reports every hiddenByBrowser and missingFromSnapshot
 * mismatch between them.
 *
 * Precondition: `tree` and `cdpTree` must describe the SAME scope (the same
 * element, from the same settled moment) -- same requirement diffTrees has
 * for `before`/`after` coming from the same page load. `cdpTree` scoped
 * narrower than `tree` would make real content outside it look
 * hiddenByBrowser; this function trusts the caller got that right rather
 * than re-deriving scope itself.
 */
export function crossCheck(
  tree: AriaNode[],
  cdpTree: { tree: CdpTreeNode[]; ignored: Map<number, IgnoredNode> },
  refMap: Map<string, number>,
): CrossCheckMismatch[] {
  const cdpById = indexByBackendId(cdpTree.tree);

  const standFor = new Set<number>();
  collectStandIns(tree, cdpTree.tree, refMap, cdpById, standFor);

  const hidden: HiddenByBrowser[] = [];
  walkHidden(tree, "", refMap, cdpById, cdpTree.ignored, hidden);

  const missing: MissingFromSnapshot[] = [];
  walkMissing(cdpTree.tree, "", standFor, missing);

  return [...hidden, ...missing];
}

// Every backendNodeId a snapshot ref resolves to that's explained by NEITHER
// cdpTree.tree (exposed) NOR cdpTree.ignored (ignored, with a reason) --
// walkHidden's "structural omission" case, which it correctly treats as "not
// hidden" when the real explanation is a folded-away structural wrapper (a
// rowgroup, say). But it isn't always that: confirmed against a real
// capture, a plain `inert` region's own content can be missing from
// Chromium's full tree for a completely different reason (see
// resolveMissingReasons below) -- this is the pure part of telling "nothing
// to explain" apart from "something explains this, we just don't have it
// yet", so it's testable on its own, with no CDP session, same as the rest
// of this file.
export function findUnexplainedBackendIds(
  nodes: AriaNode[],
  refMap: Map<string, number>,
  cdpById: Map<number, CdpTreeNode>,
  ignored: Map<number, IgnoredNode>,
  out: Set<number> = new Set(),
): Set<number> {
  for (const node of nodes) {
    if (node.role === "text") continue;
    if (node.ref !== undefined) {
      const backendNodeId = refMap.get(node.ref);
      if (backendNodeId !== undefined && !cdpById.has(backendNodeId) && !ignored.has(backendNodeId)) {
        out.add(backendNodeId);
      }
    }
    findUnexplainedBackendIds(node.children, refMap, cdpById, ignored, out);
  }
  return out;
}

/**
 * #136's own documented fallback for a backendNodeId findUnexplainedBackendIds
 * flags: "If the element isn't in the full tree at all,
 * getPartialAXTree({backendNodeId, fetchRelatives: false}) returns the
 * reasons." Confirmed against a real capture (a plain `inert` region's
 * button, reachable in the AI-mode snapshot with a real ref): unlike
 * aria-hidden or a native dialog's automatic inertness -- both of which DO
 * come back as `ignored: true` AXNodes with real reasons in
 * Accessibility.getFullAXTree's results, confirmed by the showModal() test
 * above -- Chromium can omit a plain-inert subtree's AXNodes from that same
 * call's results ENTIRELY. Not ignored:true with a reason; just absent, which
 * is exactly what made this look like a structural omission (the rowgroup
 * case) when it isn't one: there's no content here for anything to be
 * "promoted" into, just a backendNodeId the full tree never mentioned.
 *
 * This is a live CDP call, so -- same as snapshotTree/getCdpTree/resolveRefs
 * -- it can't live inside the pure crossCheck() itself (see this file's own
 * top comment); it's the one extra piece of I/O a caller does first, in the
 * same spirit as getCdpTree being the thin live wrapper around
 * normalizeAXTree's pure core (cdp-tree.ts). Callers merge the returned
 * entries into cdpTree.ignored before calling crossCheck -- walkHidden's
 * existing logic (`ig && !hasExposedDescendant(...)`) then reports them
 * correctly without any change of its own, because the data it was missing
 * is now there.
 *
 * A backendNodeId getPartialAXTree reports as NOT ignored either is left out
 * of the result, not guessed at: crossCheck already treats "explained by
 * neither" as a non-hidden structural omission, which stays the right call
 * for whatever that turns out to be.
 */
export async function resolveMissingReasons(
  link: CdpLink,
  tree: AriaNode[],
  cdpTree: { tree: CdpTreeNode[]; ignored: Map<number, IgnoredNode> },
  refMap: Map<string, number>,
): Promise<Map<number, IgnoredNode>> {
  const result = new Map<number, IgnoredNode>();
  if (!link.available) return result;

  const cdpById = indexByBackendId(cdpTree.tree);
  const unexplained = findUnexplainedBackendIds(tree, refMap, cdpById, cdpTree.ignored);

  for (const backendNodeId of unexplained) {
    const { nodes } = (await link.session.send("Accessibility.getPartialAXTree", {
      backendNodeId,
      fetchRelatives: false,
    })) as { nodes: AXNode[] };
    const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId) ?? nodes[0];
    if (!node?.ignored) continue; // Genuinely not ignored -- nothing to add.
    result.set(backendNodeId, {
      backendNodeId,
      role: (node.role?.value as string | undefined) || undefined,
      reasons: (node.ignoredReasons ?? []).map((r) => r.name),
    });
  }

  return result;
}
