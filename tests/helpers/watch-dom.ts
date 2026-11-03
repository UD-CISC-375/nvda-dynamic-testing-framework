import type { Page } from "@playwright/test";

/** One DOM change (or focus move), copied out of the browser as plain data. */
export type DomChange = {
  type: "attributes" | "childList" | "characterData" | "focus";
  target: string; // e.g. 'button#actions-button' (for text edits: the element holding the text; for focus: the newly focused element)
  attributeName: string | null; // set when type === "attributes"
  oldValue: string | null; // attribute value before the change (null = attribute was absent); for focus: the previously focused element (null = none or body)
  newValue: string | null; // attribute value now (null = attribute was removed)
  added: string[]; // nodes inserted (childList changes)
  removed: string[]; // nodes removed (childList changes)
  text: string | null; // target's text after the change (childList / characterData changes)
  inLiveRegion: boolean; // inside role=status/alert/log or aria-live, i.e. a screen reader would announce it
};

/**
 * Starts a MutationObserver on the element matching `rootSelector` and
 * records every change inside it, plus every focus move onto an element
 * inside it (as type "focus"). Call this AFTER the page has rendered and
 * BEFORE doing whatever causes the change (e.g. the click), otherwise the
 * change can happen before anyone is listening.
 *
 * `rootSelector` defaults to "body", which watches the whole page. Use that
 * when you don't know the page's structure in advance (e.g. someone else's
 * site); pass a selector to only see changes inside one component.
 *
 * Elements are labeled 'tag#id' when they have an id,
 * 'tag[data-testid="x"]' when they only have a data-testid, and just 'tag'
 * otherwise.
 *
 * Only one watcher per page: a second call on the same page throws, because
 * exposeFunction can only register "__reportDomChange" once.
 *
 * Returns:
 *  - changes: the live list of everything recorded so far
 *  - waitFor(isDone, timeoutMs): resolves once isDone(changes) is true,
 *    rejects if that doesn't happen within timeoutMs
 */
export async function watchDom(page: Page, rootSelector = "body") {
  const changes: DomChange[] = [];
  // Called every time a new change arrives. waitFor() swaps in its own check.
  let onChange = () => {};

  // Direction 1: browser -> Node.
  // This creates window.__reportDomChange inside the page. When page code calls
  // it, Playwright ships the argument over to this Node process and runs our
  // callback here.
  await page.exposeFunction("__reportDomChange", (change: DomChange) => {
    changes.push(change);
    onChange();
  });

  // Direction 2: Node -> browser.
  // Everything inside this arrow function is sent to the browser and runs
  // THERE, so it can only use browser things (document, MutationObserver) and
  // the argument we pass in. It cannot see `changes` or anything else above.
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`watchDom: nothing matches ${selector}`);

    // Turn a DOM node into a short readable label like 'ul#actions-menu'.
    // Most elements outside a component have no id, so fall back to the
    // testid ('div[data-testid="toast-region"]') before the bare tag.
    const describe = (node: Node) => {
      if (!(node instanceof Element)) return node.nodeName;
      const tag = node.tagName.toLowerCase();
      if (node.id) return `${tag}#${node.id}`;
      const testId = node.getAttribute("data-testid");
      return testId ? `${tag}[data-testid="${testId}"]` : tag;
    };

    // Regions whose content changes a screen reader announces without the
    // user moving focus there (WCAG 4.1.3 Status Messages).
    const LIVE =
      '[role="status"], [role="alert"], [role="log"], [aria-live]:not([aria-live="off"])';

    const report = (records: MutationRecord[]) => {
      for (const r of records) {
        // A text edit targets the text node itself; report its element instead.
        const el =
          r.target instanceof Element ? r.target : r.target.parentElement;
        // MutationRecords hold live DOM nodes, which can't be sent to Node,
        // so we copy out just the strings we care about.
        (window as any).__reportDomChange({
          type: r.type,
          target: el ? describe(el) : describe(r.target),
          attributeName: r.attributeName,
          oldValue: r.oldValue,
          newValue: r.attributeName
            ? (r.target as Element).getAttribute(r.attributeName)
            : null,
          added: Array.from(r.addedNodes).map(describe),
          removed: Array.from(r.removedNodes).map(describe),
          text: r.type === "attributes" ? null : (el?.textContent ?? null),
          inLiveRegion: !!el?.closest(LIVE),
        });
      }
    };
    const observer = new MutationObserver(report);

    // Moving focus changes no attribute, child or text, so the observer never
    // sees it. Listen for it directly, in the capture phase so a handler that
    // stops propagation can't hide it from us.
    document.addEventListener(
      "focusin",
      (e) => {
        const el = e.target as Element;
        if (!root.contains(el)) return;
        // A script that changes the DOM and then calls .focus() fires focusin
        // before the observer's batch is delivered. Report that batch first so
        // the list stays in the order things happened.
        report(observer.takeRecords());
        // On focusin, relatedTarget is the element losing focus.
        const prev = e.relatedTarget as Element | null;
        (window as any).__reportDomChange({
          type: "focus",
          target: describe(el),
          attributeName: null, // keep null: specs filter changes by attributeName
          oldValue: prev && prev !== document.body ? describe(prev) : null,
          newValue: null,
          added: [],
          removed: [],
          text: null,
          inLiveRegion: !!el.closest(LIVE),
        });
      },
      true,
    );

    observer.observe(root, {
      subtree: true, // watch every descendant, not just root itself
      attributes: true, // attribute added / changed / removed
      attributeOldValue: true, // also record the value before the change
      childList: true, // elements inserted / removed
      characterData: true, // text edited in place (e.g. React updating a {message} slot)
      characterDataOldValue: true,
    });
  }, rootSelector);

  return {
    changes,
    waitFor(
      isDone: (changes: DomChange[]) => boolean,
      timeoutMs = 5000,
    ): Promise<DomChange[]> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `watchDom: expected change not seen within ${timeoutMs}ms. ` +
                `Recorded: ${JSON.stringify(changes, null, 2)}`,
            ),
          );
        }, timeoutMs);

        const check = () => {
          if (isDone(changes)) {
            clearTimeout(timer);
            resolve(changes);
          }
        };
        onChange = check;
        check(); // the change might already have arrived
      });
    },
  };
}
