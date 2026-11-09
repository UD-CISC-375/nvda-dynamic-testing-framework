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
| `npm run test:local-build` | Clones and builds Team Y's site, serves it locally, and runs the tests against that build |
| `npm run test:headed` | Same, but you can watch the browser |
| `npm run test:manual` | A browser opens and waits for **you** to click the menu button (2 min per test) |
| `npx playwright show-report` | Reopens the HTML report from the last run |

Pull request runs, pushes to `main`, and the nightly scheduled run test the live GitHub Pages site. To test a site branch's build as a backup, open the CI workflow in GitHub Actions, choose **Run workflow**, and enter the branch name in **site_branch** (default: `main`); the run name shows the selected branch. Developers can also use `npm run test:local-build` to test a fresh local build manually.

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
  - Not recorded: focus moving outside the watched root, focus dropped to `<body>` when the focused element is removed (no focus event fires for that), and focus inside iframes or shadow DOM.
  - One watcher per page: calling `watchDom` twice on the same page throws.
- `tests/watch-dom.spec.ts`: unit tests for `watchDom()`, tagged `@unit`. They build their own pages with `page.setContent`, so they don't need Team Y's site. Run them alone with `npx playwright test --grep @unit --project=chromium`.

