# Accessibility-tree helpers

Source: [`tests/helpers/aria-tree.ts`](../tests/helpers/aria-tree.ts) · Tests: [`tests/aria-tree.spec.ts`](../tests/aria-tree.spec.ts), [`tests/menu-aria-tree.spec.ts`](../tests/menu-aria-tree.spec.ts)

These helpers compare what assistive technology sees before and after an interaction, using Playwright's [`ariaSnapshot`](https://playwright.dev/docs/aria-snapshots).

## Why a tree diff and not just the DOM

The team defines a meaningful change as something being **added to or removed from** the page. With `watchDom` alone, the accessible menu breaks that definition. Its items are already in the DOM and are revealed by removing `hidden`. The DOM records an attribute change, not an add. In the accessibility tree, a `menu` with four `menuitem`s appears, which is the change a screen-reader user experiences. Diffing the tree covers this case and others like it.

## Two snapshots per poll

`snapshotTree(scope)` takes two snapshots of the same moment, in parallel:

| Field | Mode | Used for | Why not use it for everything |
|---|---|---|---|
| `content` | default | What a screen reader gets: roles, names, states. `aria-hidden` content is left out | No stable ids or focus marker |
| `refs` | `{ mode: "ai" }` | A stable `[ref=eN]` id on each node and the `[active]` focus marker | Leaks `aria-hidden` text, so it isn't trusted for content |

The refs make it possible to tell which node changed. For example, the menu button keeps the same ref after it changes from collapsed to expanded (see `menu-aria-tree.spec.ts`). Use `refOf(refs, pattern)` to get the ref id of the first line that matches a regular expression.

## Waiting for the tree to settle

`waitForTreeChange(scope, before, { timeoutMs = 5000, intervalMs = 100, stableReads = 3 })` polls until:

1. the tree **differs** from `before`, and
2. the changed tree is **identical for `stableReads` polls in a row**.

It then returns the settled snapshot. If that doesn't happen within `timeoutMs`, it throws.

The comparison key ignores `[active]` and `[cursor=pointer]`. Those markers change without any content changing, and a focus move on its own shouldn't end the wait early. `aria-tree.spec.ts` checks this with a page that moves focus immediately and adds its content 600 ms later. The settled result must include the late content.

## Diffing

`diffTree(before, after)` returns `{ added, removed }` as lists of snapshot lines. It is a multiset line diff, so duplicate lines are counted separately.

**Current limitation:** the diff trims indentation, so it **ignores hierarchy**. It can't tell where in the tree a line was added, or that a node moved to a new parent. Fixing this is the job of the pending X2 stack: [#145](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/145) merges the snapshots into one tree, and [#159](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/159) adds a hierarchy-aware diff that reports added, removed, changed, and reordered nodes.

## Tree tracker

`createTreeTracker(page, scope, options)` in `tests/helpers/tree-tracker.ts` follows the accessibility tree under `scope` from one settled state to the next ([#130](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/130)). Its tests are in `tests/tree-tracker.spec.ts`: the fingerprint, poll loop and `decideEntry` tests need no browser; the rest use `page.setContent` pages, plus Team Y's menu and dialog.

- It records a settled baseline when it's created (entry 0, state 0). Each `await tracker.next()` waits for the next settled change against the last entry and returns an entry: `{ index, stateIndex, newState, tree, focusedRef, diff, focusChanges, classification, meaningful, timestamp }`. `tracker.history()` returns every entry in order, with no deduplication. Entries are plain JSON.
- An entry is one settled change. A state is what gets scanned. A meaningful entry starts a new state (`newState: true`, the next `stateIndex`), and a recorded one is logged on the current state. If the tree matches an earlier state's (compared by a fingerprint that leaves out refs and focus), a recorded entry is logged on that earlier state instead. Any earlier state counts, not only the previous one. A meaningful entry still starts a new state, even when the tree matches (for example, focus lost on the way back).
- **Settle window:** the tracker polls every `intervalMs` (default 100 ms). A changed tree counts as settled when `stableReads` polls in a row (default 3) read the same tree, so about 200 ms of holding still, plus snapshot time. A poll where the page changed while the snapshots were taken (`consistent: false`) doesn't count and restarts the run. `next()` throws if nothing settles within `timeoutMs` (default 5000 ms). Set any of these in `createTreeTracker`'s options, or per call in `next(options)`. Only settled states count: a change that comes and goes before settling is never seen (open, spike #143).
- A focus move with no tree change still makes an entry, with an empty `diff`. Settling ignores `[active]`, so the tracker counts watchDom's new focus records instead. An entry takes every focus record that arrived before it was returned, so a focus move made while the tree is settling (for example a menu focusing its first item after it renders) goes with that entry.
- `next()` checks the tree whenever it's called, with or without a user action just before, and after a click or key press even if watchDom saw no DOM change (a native checkbox, a CSS `:hover` tooltip).
- The tracker starts `watchDom(page, "body")` itself. `scope` only chooses what gets snapshotted, so focus moving out of the component is still seen. Use `tracker.watcher` for the raw records; calling `watchDom` again on the same page throws.
- **Focus facts.** The tracker records the user's last `pointerdown` and `keydown` in the page (capture phase on `window`; no `focusin` listener of its own). For each watchDom `focus` or `focusLost` record it adds `lastAction` (`{ kind, key?, msBefore }`, or `null` if there was none) and `relation`: where the newly focused element sits relative to that action's target (`same`, `inside`, `contains`, or `unrelated`; a click on or in a `<label>` counts as a click on its control). It doesn't judge them; `classify` does (#129). `relation` is `"unrelated"` for `focusLost` and when there was no action.
- Facts are measured synchronously, inside watchDom's own focus handler, by wrapping the page function watchDom reports through. At that moment `document.activeElement` is exactly the element that just got focus, so a second focus move right after can't be measured by mistake (the gotcha in #130's notes no longer applies). If a focus record ever reaches the tracker without facts (for example if watchDom stops looking the function up on each call), the tracker throws instead of guessing.
- `locator.focus()`, `dispatchEvent('click')` and `page.evaluate(() => el.focus())` fire no `pointerdown` or `keydown`, so focus they move looks page-made. Use `.click()` and `page.keyboard` in tests. Hovering fires neither, either.
- A reload or new document makes `next()` throw. Refs only last one page load, and the tracker's listeners are gone. `history.pushState` is left undetected on purpose: the tracker keeps working across it, and navigation inside a single-page app is still an open row in the definition.

## Report attachments

`attachTreeDiff(testInfo, label, before, after, diff)` adds these files to the Playwright HTML report:

- `tree-<label>-before.yaml`, `tree-<label>-after.yaml`: content snapshots
- `tree-<label>-before-refs-ai-mode.yaml`, `tree-<label>-after-refs-ai-mode.yaml`: refs snapshots
- `tree-<label>-diff.json`: the diff

## Example

```ts
import { snapshotTree, waitForTreeChange, diffTree, attachTreeDiff } from "./helpers/aria-tree";

const scope = page.locator("body");
const before = await snapshotTree(scope);
await page.getByTestId("trigger").click();
const after = await waitForTreeChange(scope, before);
const diff = diffTree(before.content, after.content);
await attachTreeDiff(testInfo, "accessible", before, after, diff);

expect(diff.added).toContainEqual(expect.stringMatching(/^- menu "Actions"/));
```
