# nvda-dynamic-testing-framework

This repository is going to be used to develop the testing framework for NVDA. There will be a separate repository linked shortly (https://github.com/mlorang/nvda-dynamic-testing-webpage) to the testing website with DOM dynamic componets for testing Dynamic DOM states to implement into NVDA.

## Menu button: accessibility before and after a DOM change

The first scenario we test is Team Y's menu button:
[https://mlorang.github.io/nvda-dynamic-testing-webpage/#/disclosure/menu?variant=accessible](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/disclosure/menu?variant=accessible)

For each variant (`accessible` and `broken`) the test:

1. Opens the page and runs an axe-core scan (the **before** baseline).
2. Starts a `MutationObserver` on `.menu-wrapper`.
3. Clicks the menu button, either automatically or by you (see below).
4. Waits for the observer to report the expected change: the button's `aria-expanded` going to `"true"` and the menu's `hidden` attribute being removed.
5. Runs the same axe scan again (the **after** scan) and reports any violations the change introduced.

### Setup

```
npm install
npx playwright install chromium
```

### Running

| Command | What it does |
|---|---|
| `npm test` | Playwright clicks the button itself (headless) |
| `npm run test:headed` | Same, but you can watch the browser |
| `npm run test:manual` | A browser opens and waits for **you** to click the menu button (2 min per test) |
| `npx playwright show-report` | Reopens the HTML report from the last run |

The HTML report opens in your browser automatically when a run finishes (press Ctrl+C in the terminal to stop the report server). In the report, each test has these attachments:

- `axe-before.json` and `axe-after.json`: the full axe results (violations, passes, incomplete) for each scan.
- `stdout`: what the test logged, including the DOM changes the observer recorded.

### What the results show

| Variant | Before | DOM change detected? | After |
|---|---|---|---|
| accessible | 0 violations | Yes: `aria-expanded` false → true, `hidden` removed | 0 violations |
| broken | `button-name` (icon button has no name) | No: the menu `<ul>` is just inserted, no state attributes | `button-name`, **nothing new** |

The tests assert these outcomes, so `npm test` passes when the broken variant fails in the expected ways.

Note that **axe reports nothing new after the broken menu opens**. axe has no way to know the button should announce "expanded". Only the DOM watcher catches that the screen reader is never told the state changed. A scan before and after on its own is not enough. We also need to check that the right kind of change happened.

## Error summary on submit

The second scenario is Team Y's form error summary:
https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/forms/error-summary?variant=accessible

For each variant the test focuses Submit and presses Enter with both fields empty, then checks how the errors are reported. The accessible test also follows the "Enter your name" link and submits again with only the name filled in.

### What the results show

| Variant | Errors visible? | Focus after submit | Inputs | axe |
|---|---|---|---|---|
| accessible | Yes, plus a summary: "There are 2 problems with your submission" with a link per error | Moves to the summary (and again on resubmit, which says "There is 1 problem…") | `aria-invalid="true"`, described by their error message | 0 violations |
| broken | Yes, next to each field only | Stays on Submit | No `aria-invalid`, no description | 0 violations |

**axe passes both variants** (this scenario is `nvdaOnly`). The broken page's HTML is valid; what's wrong is that nothing tells NVDA the errors appeared. There's no live region, so focus moving to the summary is the only way NVDA finds out. The tests catch this by checking focus and the inputs' ARIA attributes directly.

## Submission confirmation: announcement and focus after sending a form

https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/#/forms/success?variant=accessible

Sending feedback changes the button to "Sending…", then shows a confirmation. Tests use `?delay=3000` so the "Sending…" state lasts long enough to check. Each variant fills in the feedback, focuses the Send button and presses Enter. The tests use the keyboard, not `.click()`, so the focus checks mean something.

| Variant | Live region | Confirmation announced? | Form after sending | Focus after sending | axe |
|---|---|---|---|---|---|
| accessible | `role="status"`, there and empty from page load | Yes: "Thanks! Your feedback was submitted." in the status region | Still there, textarea cleared | Stays on the Send button | 0 violations |
| broken | None | No | Replaced by the message | Falls back to `<body>` | 0 violations |

**axe can't detect this flaw** (manifest: `nvdaOnly: true`). The broken page is clean to axe, but a screen reader says nothing, and a keyboard user loses their place. Only checking the live region and `document.activeElement` catches it.

### Files

- `playwright.config.ts`: points Playwright at Team Y's site (`baseURL`) and defines the `chromium` (automatic) and `manual` projects.
- `tests/menu.spec.ts`: the menu tests.
- `tests/loading.spec.ts`: the loading indicator tests.
- `tests/submission-confirmation.spec.ts`: the submission confirmation tests.
- `tests/inline-validation.spec.ts`: checks blur-triggered error feedback for accessible and broken variants, including the live DOM changes and axe scans. The semantic WCAG checks are asserted directly because axe cannot infer whether an error message belongs to a field.
- `tests/helpers/axe.ts`: `runAxe()` (scan + report attachment) and `diffViolations()` (violations that are new since the before scan).
- `tests/helpers/watch-dom.ts`: `watchDom()`, a MutationObserver in the page that reports each change back to the test, and `waitFor()`, which waits until the change we expect has been recorded (or fails after a timeout, listing everything it saw).
  - `watchDom(page)` watches the whole `<body>`, for pages whose structure you don't know in advance. `watchDom(page, selector)` only watches inside that element. The scenario specs all pass a selector.
  - Each change names the element it happened on: `tag#id` if the element has an id, otherwise `tag[data-testid="x"]` if it has a testid, otherwise just `tag`.
  - Focus moves are recorded in the same list, because moving focus changes no DOM and the observer can't see it. When focus lands on an element inside the watched root (by script or by keyboard), a change with `type: "focus"` is added: `target` is the newly focused element, `oldValue` is the element that had focus before (`null` if none or `<body>`), and `attributeName`, `text`, `added` and `removed` are empty. Changes stay in the order they happened, so a focus move made right after a DOM change comes after it in the list.
  - Playwright's `.click()` focuses the element it clicks, so a click usually records a focus change before the DOM changes it causes.
  - Focus dropped to `<body>` is recorded too (WCAG 2.4.3 Focus Order). When the focused element inside the watched root, or an ancestor of it, is removed and focus falls back to `<body>`, a change with `type: "focusLost"` is added right after the change that removed it: `target` is `"body"`, `oldValue` is the removed element that had focus, and `attributeName`, `newValue`, `text`, `added` and `removed` are empty. This also works when the element was focused before `watchDom` was called.
  - Clicking away is not a drop. If the user moves focus off the element first (for example by clicking plain text, which sends focus to `<body>`), removing that element later records nothing: the user left it, the page didn't take it away.
  - Not recorded: focus moving outside the watched root, focus lost by hiding (`hidden`, `display: none`, `inert`), disabling or moving the focused element, and focus inside iframes or shadow DOM.
  - One watcher per page: calling `watchDom` twice on the same page throws.
- `tests/watch-dom.spec.ts`: unit tests for `watchDom()`, tagged `@unit`. They build their own pages with `page.setContent`, so they don't need Team Y's site. Run them alone with `npx playwright test --grep @unit --project=chromium`.
- `tests/helpers/tree-tracker.ts`: `createTreeTracker(page, scope, options)`, which follows the accessibility tree under `scope` from one settled state to the next (#130).
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
- `tests/tree-tracker.spec.ts`: tests for the tracker. The fingerprint, poll loop and `decideEntry` tests need no browser. The rest use `page.setContent` pages, plus Team Y's menu and dialog.

