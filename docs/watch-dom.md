# `watchDom` reference

Source: [`tests/helpers/watch-dom.ts`](../tests/helpers/watch-dom.ts) · Unit tests: [`tests/watch-dom.spec.ts`](../tests/watch-dom.spec.ts) (tagged `@unit`)

`watchDom` starts a `MutationObserver` inside the page and sends each change back to the test as plain data. It also records focus moves, which a `MutationObserver` can't see because moving focus doesn't change the DOM.

## Usage

```ts
import { watchDom, DomChange } from "./helpers/watch-dom";

// The change we expect: the menu button reports it is expanded.
const menuOpened = (changes: DomChange[]) =>
  changes.some(
    (c) => c.type === "attributes" &&
      c.attributeName === "aria-expanded" &&
      c.newValue === "true",
  );

await page.goto("#/disclosure/menu?variant=accessible");
const watcher = await watchDom(page, ".menu-wrapper"); // start BEFORE the interaction
await page.getByTestId("trigger").click();
const changes = await watcher.waitFor(menuOpened);    // default timeout 5000 ms
```

Call `watchDom` **after** the page has rendered and **before** the interaction. A change that happens before the observer starts is never recorded.

## API

### `watchDom(page, rootSelector = "body")`

- `watchDom(page)` watches the whole `<body>`. Use this for pages whose structure you don't know in advance.
- `watchDom(page, selector)` only watches inside the first element matching `selector`. All the scenario specs pass a selector.
- Throws if nothing matches `selector`.
- **One watcher per page.** A second call on the same page throws, because `exposeFunction` can only register `__reportDomChange` once.

Returns:

| Property | Description |
|---|---|
| `changes` | The live array of every `DomChange` recorded so far, in the order they happened |
| `waitFor(isDone, timeoutMs = 5000)` | Resolves with `changes` once `isDone(changes)` returns true. Checks right away in case the change already happened. Rejects after `timeoutMs`, and the error message lists everything that was recorded, which makes failures easy to debug |

### `DomChange`

| Field | Meaning |
|---|---|
| `type` | `"attributes"`, `"childList"`, `"characterData"`, `"focus"`, or `"focusLost"` |
| `target` | The element the change happened on (see [labels](#element-labels)). For text edits, the element holding the text. For `focus`, the newly focused element. For `focusLost`, `"body"` |
| `attributeName` | Set when `type` is `"attributes"` |
| `oldValue` | The attribute value before the change (`null` means it was absent). For `focus`: the element that had focus before (`null` if none or `<body>`). For `focusLost`: the removed element that had focus |
| `newValue` | The attribute value now (`null` means it was removed) |
| `added`, `removed` | Nodes inserted or removed (`childList` changes) |
| `text` | The target's text after the change (`childList` and `characterData` changes) |
| `inLiveRegion` | `true` if the change is inside `role="status"`, `role="alert"`, `role="log"`, or an `aria-live` region other than `aria-live="off"`, meaning a screen reader would announce it |

## Element labels

Each change names its element:

1. `tag#id` if the element has an id
2. otherwise `tag[data-testid="x"]` if it has a test id
3. otherwise just `tag`

## Focus rules

Focus moves are recorded in the same list as DOM changes, so their order is kept. A focus move made right after a DOM change comes after it in the list.

- **`focus`**: added when focus lands on an element inside the watched root, whether a script or the keyboard moved it.
- **Playwright's `.click()` focuses the element it clicks**, so a click usually records a `focus` change *before* the DOM changes it causes.
- **`focusLost`** (WCAG 2.4.3 Focus Order): added when the focused element inside the root, or an ancestor of it, is removed and focus falls back to `<body>`. It comes right after the change that removed the element. This also works when the element already had focus before `watchDom` was called.
- **Clicking away is not a drop.** If the user moves focus off the element first (for example by clicking plain text, which sends focus to `<body>`), removing that element later records nothing. The user left it, so the page didn't take focus away.

### Not recorded

- Focus moving outside the watched root
- Focus lost by hiding (`hidden`, `display: none`, `inert`), by disabling the focused element, or by moving it
- Focus inside iframes or shadow DOM

## Running the unit tests

The unit tests build their own pages with `page.setContent`, so they don't need the test site:

```bash
npx playwright test --grep @unit --project=chromium
```
