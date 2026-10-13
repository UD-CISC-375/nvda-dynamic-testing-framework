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

## Loading indicator: status messages (WCAG 2.2, 4.1.3)

https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/#/live/loading?variant=accessible

Clicking "Load results" shows a spinner, then 5 results. Tests use `?delay=3000` so axe can scan while the spinner is showing. Each variant gets three axe scans (**before**, **during** loading, **after**) and a `MutationObserver` on the scenario root.

**axe-core has no rule for 4.1.3 Status Messages.** The watcher covers it instead: it marks every change that happens inside a live region (`role="status"`, `alert`, `log`, or `aria-live`) with `inLiveRegion`, and records the text a screen reader would announce in `text`.

| Variant | Before | During (spinner) | Announced? | After |
|---|---|---|---|---|
| accessible | 0 violations | 0 (spinner is `aria-hidden`) | Yes: "Loading results…" then "Loaded 5 results" in `role="status"`, `aria-busy` true → false | 0 violations |
| broken | 0 violations | `svg-img-alt` (spinner is `role="img"` with no name) | No: the spinner and list are inserted, nothing in a live region | 0 violations |

In the broken variant, axe only catches the problem *during* loading. A scan after loading is clean, even though a screen reader user was never told anything happened.

### Files

- `playwright.config.ts`: points Playwright at Team Y's site (`baseURL`) and defines the `chromium` (automatic) and `manual` projects.
- `tests/menu.spec.ts`: the menu tests.
- `tests/loading.spec.ts`: the loading indicator tests.
- `tests/helpers/axe.ts`: `runAxe()` (scan against WCAG 2.0/2.1/2.2 A and AA rules, plus report attachment) and `diffViolations()` (violations that are new since the before scan).
- `tests/helpers/watch-dom.ts`: `watchDom()`, a MutationObserver in the page that reports each change back to the test, and `waitFor()`, which waits until the change we expect has happened. Each change records its text and whether it happened inside a live region.
