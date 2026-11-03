// Import only the TreeChange type (the diff entries that classify labels).
import type { TreeChange } from "./diff-trees";

// What the definition (#124) says to do with a change. Meaningful: a new state, scanned by axe.
// Recorded: logged on the current state, with no new state and no scan. Ignored: dropped.
export type Label = "meaningful" | "recorded" | "ignored";

// One row of the mapping table: the label, and whether the team's decision is still pending.
type Rule = { label: Label; provisional?: true };

// The mapping table: the meaningful-change definition as data. Each key is the reason a change
// gets its label, and is copied onto the change so reports and failing tests say which row
// applied. If the team changes a decision, edit this table and its test; nothing else.
export const RULES = {
  // A node appearing, disappearing or changing parent is a new state.
  "tree:added": { label: "meaningful" },
  "tree:removed": { label: "meaningful" },
  "tree:moved": { label: "meaningful" },
  // An identical copy swapped in (#128). Deferred; the team is leaning meaningful.
  "tree:replaced": { label: "meaningful", provisional: true },
  // Changes inside a node that stays put are logged on the current state.
  "tree:textChanged": { label: "recorded" },
  "tree:stateChanged": { label: "recorded" },
  "tree:nameChanged": { label: "recorded" },
  "tree:reordered": { label: "recorded" },
  // Returning to an earlier state: the page is somewhere already scanned, so every tree change
  // is only logged, whatever its kind. Focus changes are still judged on their own.
  "tree:matchesState": { label: "recorded" },
  // The focused element was removed and focus fell to <body> (#116): the user lost their place.
  "focus:lost": { label: "meaningful" },
  // Focus moved somewhere the user didn't send it, e.g. into a dialog or back to the opener.
  "focus:page-moved": { label: "meaningful" },
  // Focus went where the user sent it: the next field after a Tab, or the thing they just
  // clicked (FOLLOW_WINDOW_MS and FOLLOWS_CLICK below say what counts for a click).
  "focus:followed-tab": { label: "recorded" },
  "focus:followed-click": { label: "recorded" },
  // iframe contents → ignored. No row needed: default-mode snapshots don't go into iframes, so
  // those changes never reach classify ("changes inside an iframe produce no TreeChange" in
  // tests/aria-tree.spec.ts fails if that stops being true).
  // The first Record makes TypeScript demand a row for every TreeChange kind; the second
  // lets rows that aren't tree kinds sit in the same table.
} as const satisfies Record<`tree:${TreeChange["kind"]}`, Rule> & Record<string, Rule>;

// The key of one table row.
export type Reason = keyof typeof RULES;

// How soon after a click a focus move must come to count as the user's. Browsers move focus
// during the event itself, so real follows take a few ms; a move later than this was made by
// the page. Tab has no window (#129): a move after a Tab is the user's however late it comes.
// A starting guess: check it against Team Y's dialog and menu scenarios.
export const FOLLOW_WINDOW_MS = 100;

// Where focus can land after a click and still be the user's doing: on the clicked element,
// inside it, or on an element around it (a <span> clicked inside a <button>).
export const FOLLOWS_CLICK: readonly Relation[] = ["same", "inside", "contains"];

// The user's last pointerdown or keydown before a focus change, as the tracker measured it.
export type LastAction = {
  kind: "pointerdown" | "keydown";
  // The raw KeyboardEvent.key on keydown ("Tab" for Shift+Tab too).
  key?: string;
  // How long before the focus change it happened.
  msBefore: number;
};

// Where the newly focused element sits relative to the last action's target, checked in this
// order: the same element, inside the target, containing the target (a <span> clicked inside a
// <button>), or none of those.
export type Relation = "same" | "inside" | "contains" | "unrelated";

// One focus record from watchDom, with the facts the tracker (#130) measured for it. The first
// three fields are the ones #115 (focus) and #116 (focusLost) specify for watchDom's records.
export type FocusChange = {
  type: "focus" | "focusLost";
  // Label of the newly focused element ("body" for focusLost).
  target: string;
  // Label of the element that had focus before, or null if none or <body>.
  oldValue: string | null;
  // null when there was no user action before it.
  lastAction: LastAction | null;
  relation: Relation;
};

// One change with the label its row gave it.
export type ClassifiedChange = {
  change: TreeChange | FocusChange;
  label: Label;
  reason: Reason;
  // Only on rows whose decision is still pending.
  provisional?: true;
};

// Everything classify decides about one entry. Plain data, so it can go into JSON reports (#102).
export type Classification = {
  // An entry is meaningful if any of its changes are.
  meaningful: boolean;
  changes: ClassifiedChange[];
};

// What the tracker (#130) passes in for one entry.
export type ClassifyInput = {
  // Tree changes from diffTrees (#127, #128).
  diff: TreeChange[];
  // watchDom's focus and focusLost records since the last entry, in the order they happened.
  focusChanges?: FocusChange[];
  // Set when the new tree's fingerprint matches an earlier state's.
  matchesState?: boolean;
};

// Attach a table row's label (and provisional flag, if it has one) to a change.
function labelled(change: TreeChange | FocusChange, reason: Reason): ClassifiedChange {
  // Widen to Rule so `provisional` can be read on every row, not only the ones that have it.
  const rule: Rule = RULES[reason];
  // Leave the key out entirely on decided rows, so reports only show it where it matters.
  return rule.provisional
    ? { change, label: rule.label, reason, provisional: true }
    : { change, label: rule.label, reason };
}

// Label every change in one entry with the definition's table. A pure function: an empty
// input just gives meaningful: false. Whether an empty diff makes a new state is the
// tracker's call (#130), not this one's.
export function classify({ diff, focusChanges = [], matchesState = false }: ClassifyInput): Classification {
  // Back at an earlier state, one row covers every tree change; otherwise the row is the kind's.
  const tree = diff.map((c) => labelled(c, matchesState ? "tree:matchesState" : `tree:${c.kind}`));
  // Focus is judged on its own: matchesState comes from the tree, which holds no focus.
  const focus = focusChanges.map((c) => labelled(c, focusReason(c)));
  // Tree changes first, then focus changes, each in the order they came in.
  const changes = [...tree, ...focus];
  return { meaningful: changes.some((c) => c.label === "meaningful"), changes };
}

// Pick the table row for one focus record.
function focusReason(change: FocusChange): Reason {
  // Focus dropped to <body> because its element was removed.
  if (change.type === "focusLost") return "focus:lost";
  const action = change.lastAction;
  // A Tab explains the move whenever it came (#129 gives Tab no window). KeyboardEvent.key is
  // "Tab" for Shift+Tab too, so one check covers both directions.
  if (action?.kind === "keydown" && action.key === "Tab") return "focus:followed-tab";
  // A click explains it only right after, and only if focus landed on, in or around what was clicked.
  if (
    action?.kind === "pointerdown" &&
    action.msBefore <= FOLLOW_WINDOW_MS &&
    FOLLOWS_CLICK.includes(change.relation)
  ) {
    return "focus:followed-click";
  }
  // Nothing the user did explains it, so the page moved focus.
  return "focus:page-moved";
}
