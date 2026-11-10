# Contributing

Two CISC375 application teams work on this repository. **Team X** handles detection: the DOM watcher, the accessibility-tree diff, the combined pipeline, and the scenario tests. **Team Y** owns the test site, scenario data, reporting, and CI and repo upkeep. Future classes are expected to pick the project up where it stops.

## Workflow

1. **Start from an issue.** Use the [Feature / Task template](../.github/ISSUE_TEMPLATE/feature.md): description, acceptance criteria, what's out of scope, notes. Issue titles carry an epic id, for example `[X2.5]` or `[Y3.6]`. Large pieces of work are a parent issue with sub-issues.
2. **Branch per issue.** Branches follow `<topic>/<team>_<issue-id>/<github-user>`:
   - `upgrade-aria-tree-diff/x_x2.1/agoldring`
   - `ci-and-repo/y_y3.1/benmonti`

   See the CISC 375 Branch Naming Convention Guide ([#39](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/issues/39)).
3. **Open a PR into `main`** using the [PR template](../.github/pull_request_template.md). It covers what changed, `Closes #`, how to test, follow-up work, AI usage, and a checklist.
4. **Stacked PRs.** When one issue builds on another's unmerged work, base the new PR on the previous branch instead of `main`, and say so at the top of the description (see [#159](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/159)–[#161](https://github.com/UD-CISC-375/nvda-dynamic-testing-framework/pull/161)). If a reviewer finds a problem in an earlier PR of the stack, fix it in the next PR and note which issue the fix belongs to. Don't rewrite a PR that's already open.
5. **CI must pass** before merging (see below).

## CI

[`.github/workflows/ci.yaml`](../.github/workflows/ci.yaml) runs on every PR into `main` and every push to `main`:

1. Install the framework (`npm ci`, Node from `.nvmrc`).
2. Check out and build the test site, then serve it locally at `http://127.0.0.1:4173/nvda-dynamic-testing-webpage/`.
3. Install Playwright Chromium.
4. `npm run type-check`.
5. `npm test`, with `BASE_URL` pointing at the local build. CI retries failing tests twice and records a trace on the first retry.
6. Upload the Playwright HTML report as the `playwright-report` artifact (kept for 30 days), even when tests fail.

To reproduce a CI run on your machine, use `npm run test:local-build`.

## Tests

- Every new scenario gets its own spec in `tests/`, testing **both** variants. See [scenarios.md](scenarios.md#adding-a-new-scenario-test).
- Helpers get unit tests that don't depend on the test site. Build pages with `page.setContent` or use `tests/fixtures/`. Tag them `@unit` where possible.
- Don't import from a `.spec.ts` file in another spec. That registers its tests a second time. Duplicate the small helper or move it into `tests/helpers/`.
- Keep tests up to date. A Testing Report may become part of the sprint deliverables.

## Documentation

If your change alters behavior, update the matching doc in the same PR (the PR template's checklist asks for this):

| You changed | Update |
|---|---|
| A scenario spec | [README coverage table](../README.md#scenario-coverage), [scenarios.md](scenarios.md) |
| `watch-dom.ts` | [watch-dom.md](watch-dom.md) |
| `aria-tree.ts` | [aria-tree.md](aria-tree.md) |
| The meaningful-change rules, pipeline, or results format | [how-it-works.md](how-it-works.md) |
| What's merged or pending | The README **Status** section |

## Generative AI

AI tools are allowed. Per the PR template, all AI-produced code and information must be commented or labeled as AI-generated, with the tool named, and must be fully tested and explainable by the person or team submitting it.
