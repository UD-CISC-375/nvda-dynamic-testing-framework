# nvda-dynamic-testing-framework

This repository is going to be used to develop the testing framework for NVDA. There will be a separate repository linked shortly (https://github.com/mlorang/nvda-dynamic-testing-webpage) to the testing website with DOM dynamic componets for testing Dynamic DOM states to implement into NVDA.

## Menu button: accessibility before and after a DOM change

The first scenario we test is Team Y's menu button:
https://mlorang.github.io/nvda-dynamic-testing-webpage/#/disclosure/menu?variant=accessible

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

### Files

- `playwright.config.ts`: points Playwright at Team Y's site (`baseURL`) and defines the `chromium` (automatic) and `manual` projects.
- `tests/menu.spec.ts`: the menu tests.
- `tests/loading.spec.ts`: the loading indicator tests.
- `tests/helpers/axe.ts`: `runAxe()` (scan against WCAG 2.0/2.1/2.2 A and AA rules, plus report attachment) and `diffViolations()` (violations that are new since the before scan).
- `tests/helpers/watch-dom.ts`: `watchDom()`, a MutationObserver in the page that reports each change back to the test, and `waitFor()`, which waits until the change we expect has happened. Each change records its text and whether it happened inside a live region.
