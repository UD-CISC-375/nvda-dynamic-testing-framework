// trackExposure (#137): compares each settled poll's crossCheck result (#136) against the
// previous poll's, and reports exposure changes -- the CDP counterpart to #127's TreeChange,
// fed into #129's classifier as the entry's cdpChanges, next to diff. It doesn't judge the
// changes it finds (#129's job, same as diffTrees/crossCheck); it only reports them.
//
// Unlike crossCheck, this isn't a single pure function: "a mismatch present since the
// baseline that never changed" (a standing finding, listed once per tracker, not a change)
// has to accumulate across every poll, not just the two being compared right now. #130's real
// tracker doesn't exist yet -- #137 depends only on #136 and #129, not #130; the "tracker" and
// "lastTree" the issue references are #130's eventual contract, not something that has to be
// built first, and wiring this into that tracker is #139's job. createExposureTracker below is
// a small standalone accumulator with the shape a #130 caller will eventually drive: poll()
// once per settled state, in order, nothing else in between.
import type { CrossCheckMismatch } from "./cross-check";

// One mismatch becoming newly hidden-from, or newly exposed-to, assistive tech between two
// settled polls.
export type ExposureChanged = {
  kind: "exposureChanged";
  // Same path format as CrossCheckMismatch's (nodeLabel + childPath -- see cross-check.ts).
  path: string;
  // Only set when the mismatch was a hiddenByBrowser one; a missingFromSnapshot mismatch has
  // no ref of its own (see CrossCheckMismatch).
  ref?: string;
  backendNodeId: number;
  // "hidden": this mismatch is new this poll. "exposed": it was there last poll and is gone
  // now. Named for the dominant case (an element Chromium hides or exposes), but applies the
  // same way to a missingFromSnapshot mismatch appearing or resolving.
  direction: "hidden" | "exposed";
  // hiddenByBrowser's ignoredReasons, verbatim. [] for a missingFromSnapshot-origin entry --
  // CDP gives no "reason" for a node the snapshot simply hasn't caught up with; the mismatch
  // itself is the explanation.
  reasons: string[];
};

// The only CDP change kind right now -- kept as its own type (not folded into
// ExposureChanged) so classify.ts's satisfies constraint reads the same way it does for tree
// kinds (see classify.ts's RULES and its `cdp:${CdpChange["kind"]}` row).
export type CdpChange = ExposureChanged;

// A mismatch crossCheck has reported on every poll since the tracker's baseline, with no
// exposureChanged ever recorded for it. Not a change -- #137 is explicit about that -- so it
// never reaches classify; reported once per tracker instead, via findings() below.
export type StandingFinding = {
  backendNodeId: number;
  mismatch: CrossCheckMismatch;
};

// This mismatch's identity across polls. Both CrossCheckMismatch kinds carry a backendNodeId
// (hiddenByBrowser's was added for this, #137) -- stable within one document, unlike `path`,
// which can shift when siblings reorder.
function idOf(mismatch: CrossCheckMismatch): number {
  return mismatch.backendNodeId;
}

function reasonsOf(mismatch: CrossCheckMismatch): string[] {
  return mismatch.kind === "hiddenByBrowser" ? mismatch.reasons : [];
}

function toChange(mismatch: CrossCheckMismatch, direction: "hidden" | "exposed"): ExposureChanged {
  return {
    kind: "exposureChanged",
    path: mismatch.path,
    ...(mismatch.kind === "hiddenByBrowser" && mismatch.ref !== undefined && { ref: mismatch.ref }),
    backendNodeId: idOf(mismatch),
    direction,
    reasons: reasonsOf(mismatch),
  };
}

function sameReasons(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

/**
 * Tracks exposure across every poll it's fed, in order.
 *
 * `poll(current)` compares `current` against the previous call's mismatches and returns this
 * poll's CdpChange[], for the caller to put in the entry's cdpChanges, next to diff (#139). The
 * very first call establishes the tracker's baseline instead of reporting changes -- there's
 * nothing yet to compare it against, and every mismatch it finds starts out a standing finding.
 *
 * `findings()` returns every mismatch that's been present, unchanged, since the baseline. Call
 * it once, whenever the caller wants the standing-findings report -- not once per poll.
 *
 * An identical copy swapped into a mismatched node (#128's replace case, the same thing
 * mergeReplaced handles for tree diffs) gives the new copy a new backendNodeId, so naively this
 * would look like one mismatch resolving and an unrelated one appearing. Paired the way
 * mergeReplaced pairs removed/added entries -- same path, same reasons, opposite directions --
 * and dropped from the poll's changes entirely. Since this wasn't a real change, the
 * replacement's new id also inherits the old id's standing status, so a baseline finding
 * survives a transparent swap instead of silently falling out of future findings() calls.
 */
export function createExposureTracker(): {
  poll(current: CrossCheckMismatch[]): CdpChange[];
  findings(): StandingFinding[];
} {
  let started = false;
  let previous = new Map<number, CrossCheckMismatch>();
  // backendNodeIds that have never had an exposureChanged recorded for them since the
  // baseline (carried forward through a replace -- see poll() below).
  let standing = new Set<number>();

  function poll(current: CrossCheckMismatch[]): CdpChange[] {
    const currentById = new Map(current.map((m): [number, CrossCheckMismatch] => [idOf(m), m]));

    if (!started) {
      started = true;
      standing = new Set(currentById.keys());
      previous = currentById;
      return [];
    }

    const hidden: { id: number; change: ExposureChanged }[] = [];
    for (const [id, mismatch] of currentById) {
      if (!previous.has(id)) hidden.push({ id, change: toChange(mismatch, "hidden") });
    }
    const exposed: { id: number; change: ExposureChanged }[] = [];
    for (const [id, mismatch] of previous) {
      if (!currentById.has(id)) exposed.push({ id, change: toChange(mismatch, "exposed") });
    }

    // Pair an exposed half with a hidden half at the same path with the same reasons -- an
    // identical replacement, not a real change -- and drop both. If the exposed half was
    // still a standing finding, the hidden half's (new) id inherits that status.
    const pairedHidden = new Set<number>();
    const pairedExposed = new Set<number>();
    for (const e of exposed) {
      const match = hidden.find(
        (h) =>
          !pairedHidden.has(h.id) && h.change.path === e.change.path && sameReasons(h.change.reasons, e.change.reasons),
      );
      if (match) {
        pairedHidden.add(match.id);
        pairedExposed.add(e.id);
        if (standing.has(e.id)) standing.add(match.id);
      }
    }

    // Every id that actually changed (unpaired) stops being a standing finding; a paired
    // hidden id is left alone, since it either just inherited standing or was never in it.
    for (const { id } of hidden) if (!pairedHidden.has(id)) standing.delete(id);
    for (const { id } of exposed) standing.delete(id);

    previous = currentById;
    return [
      ...hidden.filter((h) => !pairedHidden.has(h.id)).map((h) => h.change),
      ...exposed.filter((e) => !pairedExposed.has(e.id)).map((e) => e.change),
    ];
  }

  function findings(): StandingFinding[] {
    // Safe: `standing` is always a subset of `previous`'s keys -- every id added to it (at the
    // baseline, or inherited through a replace) is, at that same moment, a key of currentById,
    // which becomes `previous` before poll() returns.
    return [...standing].map((id) => ({ backendNodeId: id, mismatch: previous.get(id)! }));
  }

  return { poll, findings };
}
