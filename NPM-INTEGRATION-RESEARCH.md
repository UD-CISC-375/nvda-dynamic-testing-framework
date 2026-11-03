# npm Integration Research

## Summary

This repository already uses npm to install and run its JavaScript/TypeScript
development and test tools. That is different from distributing the NVDA
dynamic testing framework as an npm library. The current package is marked
private, and the tests and helpers are structured as a Playwright test suite,
not as a general-purpose package that another application can import.

If npm is a required project technology, the most useful next step is to make
the framework consumable by application developers through a documented,
versioned package or installable test harness. npm would be part of the
development and validation workflow, not something a person using a website
with NVDA needs to install.

## What the repository does today

- [`package.json`](./package.json) defines the project as
  `nvda-dynamic-testing-framework`, sets `"private": true`, and provides
  `npm test`, `npm run test:headed`, and `npm run test:manual` scripts.
- The package depends on `@axe-core/playwright`; Playwright, TypeScript, and
  Node.js types are development dependencies.
- [`package-lock.json`](./package-lock.json) locks the resolved dependency
  versions so contributors can install a consistent dependency tree with
  `npm install` (or `npm ci` in automation).
- [`playwright.config.ts`](./playwright.config.ts) configures Chromium and
  targets the separate dynamic-testing webpage.
- Tests such as [`tests/inline-validation.spec.ts`](./tests/inline-validation.spec.ts)
  exercise interactions, inspect DOM mutations, and run axe scans before and
  after a state change. Helpers in `tests/helpers/` support those tests.
- The [`README.md`](./README.md) already documents setup and test commands.

This is meaningful npm use today: npm installs dependencies and exposes project
commands. It does not yet make the framework installable by another project.
The `"private": true` setting prevents accidental publication, and test files
and their helpers are not currently presented as a stable public API.

## How npm distribution would affect this codebase

An npm package would let another JavaScript/TypeScript project install and
reuse framework functionality rather than copying tests or depending on this
repository's internal file layout. For example, an application developer could
install a package as a development dependency and write checks against their
own interactive components.

The repository would need several changes before that is appropriate:

1. **Define the package boundary.** Decide which stable functionality consumers
   need. A plausible first boundary is reusable Playwright test helpers for
   observing dynamic DOM changes and checking expected accessibility state
   changes. The current scenarios and website-specific selectors should remain
   examples/tests unless they are deliberately designed as configurable
   package features.
2. **Separate public code from test code.** Move or expose the reusable
   functionality through a source entry point, rather than asking consumers to
   import from `tests/helpers/`. Keep this repository's integration tests as
   package tests.
3. **Add package build and metadata.** Provide a build output and package
   `exports`/entry points, TypeScript declarations if consumers are expected to
   use TypeScript, supported Node.js/Playwright versions, and a license. Add
   `files` or an equivalent allowlist so test artifacts and unrelated files
   are not published.
4. **Choose a distribution model.** For a public npm release, remove the
   private-package safeguard only after the package boundary, license, and
   publication process are approved. A private registry or Git-based
   dependency can be used if the package should remain restricted.
5. **Test the consumer experience.** Add a clean-install/consumer smoke test
   that installs the built package and exercises its documented entry points.
   Continue testing the framework against the dynamic-testing webpage.
6. **Document and version it.** Explain installation, configuration, examples,
   compatibility, and errors. Use semantic versions and a release process so
   consuming projects can upgrade predictably.

This is an additive change to the developer/test tooling. It does not require
adding npm or Node.js to the runtime of the webpage or to NVDA. If a future
framework feature does run in a webpage, that would be a separate design with
its own runtime and accessibility implications.

## How npm supports the overall project goal

The repository describes its purpose as developing a testing framework for
NVDA, with a separate webpage containing dynamic DOM scenarios. The current
test design demonstrates why dynamic checks matter: axe can detect some
accessibility violations, but it cannot infer every expected interaction
signal. For example, the inline-validation test checks whether an error becomes
associated with its field; a visible error alone is not enough to prove the
field's programmatic state was updated.

An installable npm package can support that goal by making the framework's
repeatable dynamic checks easier for multiple application teams to adopt. The
package could standardize how developers:

- trigger an interaction that changes a component;
- observe the relevant DOM/accessibility state before and after it;
- assert the expected accessible name, state, relationship, or feedback;
- capture diagnostic output to help fix regressions.

npm itself does not make a page accessible, inspect NVDA speech, or replace
manual assistive-technology testing. It provides dependency installation,
versioning, and a familiar distribution mechanism for JavaScript-based
development tools. The framework's checks and its integration with actual
NVDA behavior must provide the accessibility value.

## Where npm fits in the user workflow

For a person visiting and using an application with NVDA, npm should normally
be invisible:

1. An application developer installs the framework in the application's
   development/test environment and adds checks for relevant dynamic
   interactions.
2. The checks run during local development or continuous integration. Failures
   give developers evidence of missing or incorrect accessibility updates.
3. Developers fix and verify the behavior before releasing the application.
4. The application user opens the released site and uses NVDA as usual.

Thus, npm contributes upstream, while the user benefits from better-tested
dynamic behavior. Installing an npm package on an end user's computer is not
part of the proposed workflow. If the course project defines a different
end-user testing role or workflow, that role should be reflected in the package
design; the syllabus text was not present in this repository to confirm further
course-specific details.

## Where npm fits in the application developer workflow

For an application developer, the likely workflow is:

1. Add the framework package as a development dependency using npm.
2. Install dependencies from the lockfile (`npm ci` in CI; `npm install` when
   changing dependencies locally).
3. Configure the tests for the target application and define which DOM or
   accessibility changes are expected after user actions.
4. Run the checks locally with an npm script, inspect failures/reports, and
   correct the application.
5. Run the same checks in CI before merging or releasing.
6. Upgrade the framework deliberately when a new compatible version is
   published.

This places npm in the same tooling layer as the project's current
`@playwright/test` and `@axe-core/playwright` dependencies. In the current
repository, `npm test` runs Chromium tests against a hosted webpage. The
configuration and scenarios should be generalized before presenting that
specific test command or those selectors as a drop-in solution for arbitrary
applications.

## Important constraints and recommendations

- **Do not publish the current repository unchanged.** It is a private
  Playwright test project, not yet a designed consumer library.
- **Keep the integration scope explicit.** The current automated browser
  checks observe DOM state and axe results. They do not establish that NVDA
  announced the right speech output; that claim requires suitable NVDA
  testing.
- **Keep static and dynamic checks complementary.** An axe scan may miss a
  missing state transition or association, so event/state-specific assertions
  remain important.
- **Treat browser automation dependencies deliberately.** Playwright browsers
  may need installation in the consumer's environment, and a helper package
  must state whether it supplies, peers with, or supports particular
  Playwright versions.
- **Protect package publishing credentials.** If release publishing is
  automated, use protected CI secrets and a reviewed release workflow; never
  commit an npm token.
- **Validate against the course's exact requirement.** The syllabus was not
  included in this repository. This document uses the project's stated goal
  and the "Course Project" / "Technologies" sections referenced in the request
  as context, but does not quote or assume additional syllabus requirements.

## Suggested first implementation

Keep the current npm-managed Playwright project intact while defining the
reusable API and testing it in this repository. Extract one small, genuinely
reusable capability (for example, DOM-change observation plus expected-change
assertions), add a consumer-oriented smoke test and usage documentation, and
only then choose whether to publish publicly or use a restricted distribution
path. This provides a demonstrable npm integration without turning the
existing scenario suite into an unstable public API.

## References

- Project setup, commands, and current goal: [`README.md`](./README.md)
- Current npm scripts and dependency classification: [`package.json`](./package.json)
- Browser/test configuration: [`playwright.config.ts`](./playwright.config.ts)
- Example dynamic validation checks: [`tests/inline-validation.spec.ts`](./tests/inline-validation.spec.ts)
- npm package metadata and publishing overview:
  [About packages and modules](https://docs.npmjs.com/about-packages-and-modules)
- npm publishing guidance:
  [Creating and publishing unscoped public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages)
