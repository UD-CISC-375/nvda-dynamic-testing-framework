# How it works

This page explains how the framework is designed: what it detects, why, and what's still open. For the APIs, see [watch-dom.md](watch-dom.md) and [aria-tree.md](aria-tree.md).

## The problem

A screen reader like NVDA doesn't read the DOM. It reads what the browser exposes through the platform accessibility API. When a page changes after it loads, the user only finds out if the page exposes the change in a way the screen reader picks up. The main ways are:

- **State attributes** such as `aria-expanded`, `aria-selected`, and `aria-invalid`
- **Live regions** (`role="status"`, `role="alert"`, `aria-live`), which are announced without moving focus
- **Focus moves**, for example to an error summary or into a dialog

Static scanners like axe check one moment. Even a scan before and after the change misses most of this. axe can confirm the "after" page is valid HTML, but it can't know that a button *should* now say "expanded", or that a message *should* have been announced. In 10 of the test site's 16 scenarios, axe finds nothing wrong with the broken variant.

## Where this sits relative to NVDA

```
 DOM  ──►  browser accessibility tree  ──►  platform API (IA2 / UIA on Windows)  ──►  NVDA
 │              │                                    │
 watchDom   ariaSnapshot (now)                   future work
            CDP tree (planned, Chromium only)
```

The framework currently works at the first two layers. Getting the detection right there comes first, because an NVDA integration has to know *which* changes matter before it can check how NVDA announces them. How the tool will eventually connect to NVDA is undecided and is expected to be future-semester work.

## The pipeline

For each interaction:

1. **Baseline.** Take an axe scan and an accessibility-tree snapshot of the page as it loaded.
2. **Watch.** `watchDom` records every DOM mutation, focus move, focus lost to `<body>`, and whether each change happened inside a live region.
3. **Interact.** Playwright clicks or types, or in `manual` mode a person does.
4. **Settle.** `waitForTreeChange` polls the accessibility tree until it has changed and then stayed identical for several polls in a row. Focus-only and cursor markers are ignored, so a quick focus move doesn't end the wait before late content arrives.
5. **After state.** Take a new axe scan and tree snapshot.
6. **Compare.** `diffViolations` gives the new axe violations, `diffTree` gives what was added to or removed from the tree, and the watcher's list gives what happened in the DOM and to focus.
7. **Assert.** Check that the right *kind* of change happened, not only that the page is valid afterwards.

On `main`, each scenario spec puts these steps together itself. A single combined pipeline (watcher + tree diff + one report per run) is planned.

## Why both the DOM and the accessibility tree

Each view misses things the other sees:

| Change | DOM (`watchDom`) | Accessibility tree |
|---|---|---|
| Accessible menu opens (`hidden` removed) | Attribute change only. Nothing added | `menu` + 4 `menuitem`s **added** |
| Focus moves | Yes (`focus` / `focusLost`) | Only as an `[active]` marker |
| Message lands in a live region | Yes (`inLiveRegion: true`) | Text appears, but "it's live" is not obvious |
| Purely visual change with no semantic effect | Yes (noise) | Nothing, which is correct |

## Meaningful change

**Working definition:** a change is *meaningful* when something is **added to or removed from** what assistive technology sees. A meaningful change creates a new page state that gets scanned again. Other changes are **recorded** in the results but don't trigger a new scan.

Decisions the team has made (Sprint 3). They are implemented by the classifier in the pending PR [#161](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/161), not yet on `main`:

| Situation | Decision |
|---|---|
| Node added or removed | Meaningful |
| Node moves to a new parent | Meaningful |
| Text changes inside an existing node | Recorded |
| State-only change (e.g. `aria-expanded`) | Recorded |
| Reordering (e.g. sorting a table) | Recorded |
| The page moves focus, or focus is lost (e.g. a closed popup) | Meaningful |
| Focus follows the user's own click or Tab | Recorded |
| Plain unnamed wrappers (`generic`) | Flattened: only their contents count |
| Returning to an earlier state | Recorded (no new scan). Focus is judged on its own |
| Change with no user action (timers, pushes) | Same rules as any other change |
| Change that doesn't touch the DOM | Always recorded, then the same rules apply |
| Identical copy swapped in (removed, then added) | Built as meaningful for now. Decision deferred ([#128](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/128)) |
| Empty element with a real role (empty list, table, live region, dialog) | Not flattened, so it's a node like any other. Its appearance is meaningful, and its content arriving later is meaningful again ([#144](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/144), closed without a spike) |
| Content inside iframes | Ignored for now |

Still open:

| Question | Tracked in |
|---|---|
| Regions that never stop changing (tickers, clocks). The likely approach is to ignore only that region | Spike [#131](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/131) |
| Changes that appear and disappear between polls | Spike [#143](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/143) |
| Single-page-app navigation | Not yet discussed |

## Design choices

- **`ariaSnapshot` as the main tree.** It is built into Playwright and works in every Playwright browser. The AI mode adds stable per-node refs, so the diff can tell *which* node changed instead of only counting changed lines. Default-mode snapshots are kept for content, because AI mode leaks `aria-hidden` text.
- **CDP tree as an extra check (planned).** Chromium's own accessibility tree, read through the Chrome DevTools Protocol, sits closer to what the platform API exposes. The plan is to run it once per settled state in Chromium only and skip it with a note in Firefox and WebKit. It doesn't replace `ariaSnapshot`.
- **A test site with paired variants.** Every scenario has an accessible and a broken version. That makes each check falsifiable: it has to pass one and catch the other. The long-term goal is for the tool to work on real sites as well.

## Results format (draft)

[`results/schema.ts`](../results/schema.ts) defines an internal, evolving JSON contract (`schemaVersion: 0`) for one run. [`examples/results.json`](../examples/results.json) shows an example. A run lists its scenarios, and each scenario variant has a verdict (`passed`, `failed`, or `skipped` with a reason) and a list of **states**. Each state records:

- the `trigger` that caused it and a `domChangeSummary`
- a `treeDiff` with `added`, `removed`, `changed`, and `reordered` nodes
- the axe results: `new` and `resolved` violations and `totalCount`
- whether the state was `stable`

Nothing on `main` writes this file yet. The pending report PR [#151](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/151) builds `results.json`. Expect the format to change.
