# Scenarios

The scenarios come from the companion test site, [nvda-dynamic-testing-webpage](https://github.com/UD-CISC-375/nvda-dynamic-testing-webpage). The [coverage table in the README](../README.md#scenario-coverage) summarizes all 16. This page has the detailed results and explains how to add a test for a new scenario.

## The test site

- Each scenario lives at a hash route, `https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/<category>/<name>`.
- `?variant=accessible` (the default) or `?variant=broken` picks the version.
- `?delay=<ms>` sets how long async updates take. Every scenario has its own default, and `0` means immediate. Tests often raise it, for example to `3000`, so that an in-between state like "Sending…" lasts long enough to check.
- The site publishes a manifest, `scenarios.json`. For each scenario it lists the route, WCAG criteria, the flaw in the broken variant, the axe rules expected to fire (`brokenRules`), and whether axe can detect the flaw at all (`nvdaOnly`). `loadScenarios(request)` in [`tests/helpers/scenarios.ts`](../tests/helpers/scenarios.ts) reads it and checks the manifest version. [`tests/scenarios.spec.ts`](../tests/scenarios.spec.ts) checks that all 16 scenarios are present.

Tests call `page.goto("#/...")`, and Playwright prepends `baseURL` from [`playwright.config.ts`](../playwright.config.ts).

## The common test pattern

Most scenario specs follow the same shape for each variant:

1. Open the page and wait for it to render. The site is a React app, and `expect(...)` retries until elements appear.
2. Run the **before** axe scan (`runAxe(page, testInfo, "before")`).
3. Start `watchDom` on the scenario's root element.
4. Do the interaction. In the `manual` project, wait for a person to do it instead.
5. `watcher.waitFor(...)` until the expected change has been recorded.
6. Assert the accessibility-relevant result directly: ARIA states, live regions, focus.
7. Run the **after** axe scan. Use `diffViolations(before, after)` to see only the violations the change introduced.

The **accessible** variant should pass every check. The **broken** variant's test asserts the specific way it fails. So `npm test` passing means both variants behaved as expected, and a broken variant that suddenly looks accessible makes the test fail.

### Adding a new scenario test

1. Find the scenario in `scenarios.json`. Note its route, `flaw`, `brokenRules`, and `nvdaOnly`.
2. Create `tests/<scenario>.spec.ts`. Copy the structure of a similar spec. [`menu.spec.ts`](../tests/menu.spec.ts) and [`toast.spec.ts`](../tests/toast.spec.ts) are good templates, including manual-mode support.
3. Write a predicate for the change you expect, and pass it to `watcher.waitFor`.
4. If axe can't see the flaw (`nvdaOnly: true`), say so in a comment at the top of the spec, and assert the flaw directly.
5. Add a row to the [README coverage table](../README.md#scenario-coverage). If the results are interesting, add a section below.

## Detailed results

### Menu button

Route: [`#/disclosure/menu`](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/disclosure/menu?variant=accessible) · Specs: [`menu.spec.ts`](../tests/menu.spec.ts), [`menu-aria-tree.spec.ts`](../tests/menu-aria-tree.spec.ts)

For each variant the DOM test:

1. Opens the page and runs an axe-core scan (the **before** baseline).
2. Starts `watchDom` on `.menu-wrapper`.
3. Clicks the menu button, either automatically or by you (`npm run test:manual`).
4. Waits for the watcher to report the expected change: the button's `aria-expanded` going to `"true"` and the menu's `hidden` attribute being removed.
5. Runs the same axe scan again (the **after** scan) and reports any violations the change introduced.

| Variant | Before | DOM change detected? | After |
|---|---|---|---|
| accessible | 0 violations | Yes: `aria-expanded` false → true, `hidden` removed | 0 violations |
| broken | `button-name` (icon button has no name) | No: the menu `<ul>` is just inserted, with no state attributes | `button-name`, **nothing new** |

**axe reports nothing new after the broken menu opens.** axe has no way to know the button should announce "expanded". Only the watcher catches that the screen reader is never told the state changed. A before-and-after scan on its own is not enough. We also need to check that the right kind of change happened.

The tree test (`menu-aria-tree.spec.ts`) looks at the same interaction through the accessibility tree:

| Variant | Added to the tree | Button |
|---|---|---|
| accessible | A `menu "Actions"` with 4 `menuitem`s | Collapsed `button "Actions"` line replaced by an expanded one, with the same ref |
| broken | A plain `list` with 4 `listitem`s, no `menu` role | No button line changes, because there is no `aria-expanded` |

### Error summary on submit

Route: [`#/forms/error-summary`](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/forms/error-summary?variant=accessible) · Spec: [`error-summary.spec.ts`](../tests/error-summary.spec.ts)

For each variant the test focuses Submit and presses Enter with both fields empty, then checks how the errors are reported. The accessible test also follows the "Enter your name" link and submits again with only the name filled in.

| Variant | Errors visible? | Focus after submit | Inputs | axe |
|---|---|---|---|---|
| accessible | Yes, plus a summary: "There are 2 problems with your submission" with a link per error | Moves to the summary (and again on resubmit, which says "There is 1 problem…") | `aria-invalid="true"`, described by their error message | 0 violations |
| broken | Yes, next to each field only | Stays on Submit | No `aria-invalid`, no description | 0 violations |

**axe passes both variants** (`nvdaOnly: true`). The broken page's HTML is valid. What's wrong is that nothing tells the screen reader the errors appeared. There's no live region, so focus moving to the summary is the only way it finds out. The tests catch this by checking focus and the inputs' ARIA attributes directly.

### Submission confirmation

Route: [`#/forms/success`](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/forms/success?variant=accessible) · Spec: [`submission-confirmation.spec.ts`](../tests/submission-confirmation.spec.ts)

Sending feedback changes the button to "Sending…", then shows a confirmation. The tests use `?delay=3000` so the "Sending…" state lasts long enough to check. Each variant fills in the feedback, focuses the Send button, and presses Enter. The tests use the keyboard rather than `.click()`, so the focus checks mean something.

| Variant | Live region | Confirmation announced? | Form after sending | Focus after sending | axe |
|---|---|---|---|---|---|
| accessible | `role="status"`, present and empty from page load | Yes: "Thanks! Your feedback was submitted." in the status region | Still there, textarea cleared | Stays on the Send button | 0 violations |
| broken | None | No | Replaced by the message | Falls back to `<body>` | 0 violations |

**axe can't detect this flaw** (`nvdaOnly: true`). axe finds nothing wrong with the broken page, yet a screen reader says nothing and a keyboard user loses their place. Only checking the live region and `document.activeElement` catches it.

### Delayed content injection

Route: [`#/dynamic/delayed-content`](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/dynamic/delayed-content?variant=accessible) · Spec: [`delayed-content.spec.ts`](../tests/delayed-content.spec.ts)

Three recommendations are added automatically after a short delay. The tests use `?delay=3000` to check the loading state before the content appears.

| Variant | Status messages | Heading and region | List | axe |
|---|---|---|---|---|
| accessible | Announces loading, then "3 recommendations loaded" | Real `h2` heading and named region | 3 list items | 0 violations |
| broken | No status messages | No real heading or named region | Plain `div` items | 0 violations |

The accessible version keeps the same status region while it updates the message. The broken version adds content without announcing it.

**axe can't detect this flaw** (`nvdaOnly: true`). The tests check the status region and the HTML structure directly.

### Load more

Route: [`#/dynamic/load-more`](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/#/dynamic/load-more?variant=accessible) · Spec: [`load-more.spec.ts`](../tests/load-more.spec.ts)

The scenario starts with 5 articles and adds 5 more each time the button is pressed, up to 15. Each variant's test loads more twice, using the keyboard (`button.press("Enter")`), and checks the status region and focus after each load.

| Variant | Status messages | Focus | axe |
|---|---|---|---|
| accessible | `"Loading more articles…"`, then `"Showing N of 15 articles"` | Moves to the first newly loaded article each time | 0 violations |
| broken | No status region at all | Stays on the button, then falls back to `<body>` once the button disappears after the last load | 0 violations |

**axe can't detect this flaw.** Both variants come back clean — a single-moment scan can't show that the broken version never tells assistive tech new content arrived, or that focus is lost once the button disappears. The tests catch it by checking the status region and focus directly.

### Other scenarios

The remaining specs on `main` (polite status, assertive alert, toast, loading, accordion, dialog, tabs, inline validation, labels, combobox) are summarized in the [README coverage table](../README.md#scenario-coverage). Each spec's header comment explains what it checks and why. Detailed result tables for them are welcome. Follow the format above.
