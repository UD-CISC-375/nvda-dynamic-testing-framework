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
