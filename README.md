# NVDA Dynamic Testing Framework

[![CI](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/actions/workflows/ci.yaml/badge.svg)](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/actions/workflows/ci.yaml)

An end-to-end testing framework that watches a web page **as it changes**, works out when a change matters to a screen-reader user, and checks accessibility again after each one. It is built with [Playwright](https://playwright.dev/) and [axe-core](https://github.com/dequelabs/axe-core).

This is groundwork for eventual integration with the [NVDA screen reader](https://github.com/nvaccess/nvda). NVDA itself is not used yet. The current focus is the detection layer that an NVDA integration would later build on. The project is developed by students in CISC375 at the University of Delaware and is meant to be continued by future classes.

The pages under test come from a companion repository: **[nvda-dynamic-testing-webpage](https://github.com/UD-CISC-375/nvda-dynamic-testing-webpage)** ([live site](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/)). It has 16 scenarios, and each one comes in an `accessible` and a `broken` variant.

## Why this exists

Accessibility scanners like axe check a page at a single moment. Many modern websites update dynamically, though, and a page that passes can become inaccessible once those updates happen. Right now there is no easy way to test these dynamic parts. Developers have to write a custom test by hand for every scenario they want to check, such as clicking a button that opens a list. That takes a long time, and it's easy to miss states. This project aims to make it easier for developers to check whether a dynamic website stays accessible, without writing those tests by hand.

## Status

What's on `main`:

- **Tests for 14 of the 16 scenarios.** Each test runs both variants and checks the accessible one passes and the broken one fails in the expected way. See [coverage](#scenario-coverage).
- **`watchDom`**: a `MutationObserver`-based watcher that records DOM changes, focus moves, and focus lost to `<body>`, and flags changes inside live regions. See [docs/watch-dom.md](docs/watch-dom.md).
- **Accessibility-tree snapshots and diffs**: takes Playwright `ariaSnapshot` snapshots, waits for the tree to settle after an action, and diffs before against after. This catches changes the DOM view misses, such as a `hidden` element being revealed. See [docs/aria-tree.md](docs/aria-tree.md).
- **Scenario manifest loader**: reads the test site's `scenarios.json` (scenario metadata, WCAG criteria, expected axe results).
- **CI** on every PR and push to `main`. It builds the test site locally, then type-checks and runs the whole suite.
- **A draft results format** ([`results/schema.ts`](results/schema.ts), [example](examples/results.json)). Nothing on `main` produces it yet.

Pending (open PRs, not merged):

| PR                                                                                                                                                                                                                                                                                                                                | What it adds                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#145](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/145) → [#159](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/159) → [#160](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/160) → [#161](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/161) | X2.2–X2.5, a stack where each PR builds on the one before. Parse and merge the snapshots into one tree, a hierarchy-aware diff, detection of replaced-but-identical nodes, and a classifier that applies the meaningful-change definition |
| [#141](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/141)                                                                                                                                                                                                                                                    | Sortable table scenario tests                                                                                                                                                                                                             |
| [#147](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/147)                                                                                                                                                                                                                                                    | Load more scenario tests                                                                                                                                                                                                                  |
| [#151](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/151)                                                                                                                                                                                                                                                    | Results report that builds `results.json`                                                                                                                                                                                                 |
| [#158](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/158)                                                                                                                                                                                                                                                    | Nightly test run against the live site                                                                                                                                                                                                    |

Next steps:

- Use Chromium's own accessibility tree (through the Chrome DevTools Protocol) as an extra check on each settled state ([#133](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/133)). This is a Chromium-only check, and `ariaSnapshot` stays the main tree.
- Research spikes on the open meaningful-change questions: regions that never stop changing ([#131](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/131)), and changes that appear and disappear before the page settles ([#143](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/143)).
- Combine the DOM watcher and the tree diff into one pipeline, with one report per run.
- Make the tool work on pages beyond the companion test site.
- Integrate with NVDA. How it connects is still undecided and is likely work for a future semester.

## Quickstart

Requires Node.js 26 (see [`.nvmrc`](.nvmrc)).

```bash
npm install
npx playwright install chromium
npm test
```

By default the tests run against the [live test site](https://ud-cisc-375.github.io/nvda-dynamic-testing-webpage/). Set `BASE_URL` to point them at another copy, for example a local build.

| Command                                               | What it does                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                            | Runs the whole suite headless. Playwright performs every click itself                                                                                                                              |
| `npm run test:headed`                                 | Same, with a visible browser                                                                                                                                                                       |
| `npm run test:manual`                                 | Opens a browser and waits for **you** to do the interaction (click the menu button, and so on). Supported by the menu, accordion, dialog, loading, toast, polite status, and assertive alert tests |
| `npx playwright test --grep @unit --project=chromium` | Only the `watchDom` unit tests. These build their own pages and don't need the test site                                                                                                           |
| `npm run type-check`                                  | TypeScript check with no output files                                                                                                                                                              |
| `npm run test:local-build`                            | Does what CI does: clones and builds the test site, serves it locally, then type-checks and tests                                                                                                  |
| `npx playwright show-report`                          | Reopens the HTML report from the last run                                                                                                                                                          |

The HTML report opens automatically after a local run. Press Ctrl+C to stop the report server. Each test attaches its evidence to the report: the axe results (`axe-before.json`, `axe-after.json`), the accessibility trees and their diff (`tree-*.yaml`, `tree-*-diff.json`), and the logged DOM changes (`stdout`).

## How it works

```
 load page ──► baseline: axe scan + accessibility-tree snapshot
                  │
 start watchDom ──┤   (records DOM changes, focus moves, live-region updates)
                  │
 interaction ─────┤   (Playwright clicks/types, or a person does in manual mode)
                  │
 wait to settle ──┤   (tree changed, then stayed the same for several polls)
                  │
 after state ─────┴─► axe scan again + tree snapshot
                        │
                        ▼
              compare: new axe violations, tree diff, recorded changes
              assert:  the RIGHT kind of change happened
```

The project's working definition of a **meaningful change** is something being added to or removed from what assistive technology sees. Scanning the DOM alone isn't enough. When the accessible menu opens, its items aren't added to the DOM, they're revealed by removing `hidden`, so the watcher sees an attribute change but no add/remove. The accessibility tree shows the menu appearing. That's why the framework watches both.

[docs/how-it-works.md](docs/how-it-works.md) covers the full pipeline, the meaningful-change rules the team has settled on, and the questions that are still open.

## Scenario coverage

axe column: rules axe flags in the **broken** variant, according to the test site's manifest. "Nothing" means the flaw can only be caught by checking the change itself.

| Scenario                  | Route                      | WCAG                       | axe flags                      | What our tests check beyond axe                                                                                                    | Spec                                                                       |
| ------------------------- | -------------------------- | -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Polite status message     | `/live/polite`             | 4.1.3                      | nothing                        | Message lands in a `role="status"` / `aria-live="polite"` region                                                                   | [polite-status](tests/polite-status.spec.ts)                               |
| Assertive error alert     | `/live/alert`              | 3.3.1, 3.3.3               | nothing                        | Error lands in a `role="alert"` region, not `aria-live="off"`                                                                      | [assertive-error-alert](tests/assertive-error-alert.spec.ts)               |
| Auto-dismissing toast     | `/live/toast`              | 4.1.3                      | nothing                        | Live region exists _before_ the toast appears and isn't replaced                                                                   | [toast](tests/toast.spec.ts)                                               |
| Loading indicator         | `/live/loading`            | 4.1.3                      | `svg-img-alt`                  | "Loading" and "Loaded" announced through a live region, `aria-busy` toggles                                                        | [loading](tests/loading.spec.ts)                                           |
| Accordion                 | `/disclosure/accordion`    | 2.1.1, 4.1.2               | nothing                        | Header is a button with `aria-expanded` and `aria-controls`                                                                        | [accordion](tests/accordion.spec.ts)                                       |
| Modal dialog              | `/disclosure/dialog`       | 4.1.2, 2.4.3, 2.1.1        | `aria-dialog-name`             | `aria-modal`, focus moves in, Tab is trapped, focus returns to the trigger                                                         | [dialog](tests/dialog.spec.ts)                                             |
| Tabs                      | `/disclosure/tabs`         | 4.1.2, 2.1.1, 1.3.1, 2.4.7 | `aria-required-parent`         | `aria-selected` moves to the clicked tab and its panel is a `tabpanel`. The broken tabs have no `tablist` and fail keyboard checks | [tabs](tests/tabs.spec.ts)                                                 |
| Menu button               | `/disclosure/menu`         | 4.1.2, 2.1.1, 1.3.1        | `button-name`                  | `aria-expanded` → true and `hidden` removed (DOM). A `menu` with 4 `menuitem`s appears (tree)                                      | [menu](tests/menu.spec.ts), [menu-aria-tree](tests/menu-aria-tree.spec.ts) |
| Inline validation         | `/forms/inline-validation` | 3.3.1, 1.4.1, 3.3.3, 1.3.1 | nothing                        | On blur: `aria-invalid` and `aria-describedby` point to the error                                                                  | [inline-validation](tests/inline-validation.spec.ts)                       |
| Error summary on submit   | `/forms/error-summary`     | 3.3.1, 2.4.3, 4.1.3        | nothing                        | Focus moves to the summary, inputs get `aria-invalid` plus a description                                                           | [error-summary](tests/error-summary.spec.ts)                               |
| Labels, hints, required   | `/forms/labels`            | 1.3.1, 3.3.2, 4.1.2        | `label`                        | Accessible names, required state, and hint descriptions (single state, no interaction)                                             | [labels](tests/labels.spec.ts)                                             |
| Submission confirmation   | `/forms/success`           | 4.1.3, 2.4.3, 3.2.2        | nothing                        | Confirmation in an existing `role="status"` region, focus not lost to `<body>`                                                     | [submission-confirmation](tests/submission-confirmation.spec.ts)           |
| Autocomplete combobox     | `/dynamic/combobox`        | 2.1.1                      | `aria-required-parent`, `list` | Combobox/listbox roles, result count announced, keyboard selection                                                                 | [combobox](tests/combobox.spec.ts)                                         |
| Delayed content injection | `/dynamic/delayed-content` | 4.1.3, 1.3.1, 2.4.6        | nothing                        | Loading/loaded status messages, real heading, named region, list items                                                             | [delayed-content](tests/delayed-content.spec.ts)                           |
| Load more                 | `/dynamic/load-more`       | 4.1.3, 2.4.3               | nothing                        | Status announcements while loading, and focus moving to the first newly loaded article                                            | [load-more](tests/load-more.spec.ts)                                      |
| Sortable table            | `/dynamic/sortable-table`  | 4.1.2, 1.3.1               | nothing                        | _Pending: [#141](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/141)_                                          |                                                                            |

The full results for each scenario, with before/after tables, are in [docs/scenarios.md](docs/scenarios.md).

## Repository layout

```
tests/
  helpers/
    watch-dom.ts       watchDom(): DOM + focus change recorder
    aria-tree.ts       snapshotTree, waitForTreeChange, diffTree, refOf, attachTreeDiff
    axe.ts             runAxe() and diffViolations()
    scenarios.ts       loadScenarios(): reads the test site's scenarios.json
  *.spec.ts            one spec per scenario, plus unit tests for the helpers
  fixtures/            standalone HTML pages used by tests
results/schema.ts      draft results.json contract (schemaVersion 0)
examples/results.json  example of that contract
scripts/               test-local-build.mjs (CI-style local run)
docs/                  detailed documentation (see below)
.github/               CI workflow, PR template, issue template
playwright.config.ts   baseURL, CI web server, `chromium` and `manual` projects
```

## Documentation

### Files
- [docs/how-it-works.md](docs/how-it-works.md): pipeline, meaningful-change definition, decisions, open questions, results format
- [docs/watch-dom.md](docs/watch-dom.md): `watchDom` API reference
- [docs/aria-tree.md](docs/aria-tree.md): accessibility-tree helpers and settle detection
- [docs/scenarios.md](docs/scenarios.md): per-scenario results and how to write a new scenario test
- [docs/contributing.md](docs/contributing.md): branches, issues, PRs, CI, AI-usage policy
- [NPM-INTEGRATION-RESEARCH.md](NPM-INTEGRATION-RESEARCH.md): research on distributing the framework as an npm package

## Related

- Test site: [UD-CISC-375/nvda-dynamic-testing-webpage](https://github.com/UD-CISC-375/nvda-dynamic-testing-webpage)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [NVDA](https://github.com/nvaccess/nvda)
