import type { CDPSession, Locator, Page } from "@playwright/test";

/**
 * The result of createCdpLink(page): either a live CDP session for that
 * page, or the reason CDP isn't available. Chrome DevTools Protocol only
 * exists on Chromium, so callers are expected to check `available` and skip
 * CDP-only checks rather than catch a thrown error.
 */
export type CdpLink =
  | { available: true; page: Page; session: CDPSession }
  | { available: false; reason: string };

// One session per page, reused across calls. Keyed by Page so it's cleared
// automatically if the page itself is ever garbage-collected. The cached
// value is the in-flight *promise*, not just the resolved link: two calls
// for the same page that race each other must still only open one session.
const linksByPage = new WeakMap<Page, Promise<CdpLink>>();

/**
 * Opens (or reuses) a CDP session for `page`. Chromium only: on any other
 * browser this resolves to `{ available: false, reason: "not Chromium" }`
 * instead of throwing, so callers (e.g. a future cross-browser tracker) can
 * skip CDP-only checks gracefully instead of wrapping every call in a
 * try/catch.
 *
 * The session is detached when the page closes; nothing reuses it after
 * that; a later createCdpLink(page) call for an already-closed page would
 * open (and immediately own) a new session, but callers aren't expected to
 * do that.
 */
export function createCdpLink(page: Page): Promise<CdpLink> {
  const cached = linksByPage.get(page);
  if (cached) return cached;

  const link = (async (): Promise<CdpLink> => {
    // page.context().browser() is null for a persistent context, and
    // browserType().name() is "firefox" / "webkit" on the other engines.
    // Either way there's no CDP to attach to.
    const browserType = page.context().browser()?.browserType().name();
    if (browserType !== "chromium") {
      return { available: false, reason: "not Chromium" };
    }

    const session = await page.context().newCDPSession(page);

    // Detach once, when the page goes away. Nothing reuses this session
    // afterward, so there's nothing to re-arm.
    page.once("close", () => {
      linksByPage.delete(page);
      void session.detach().catch(() => {
        // The target is already gone; there's nothing left to detach from.
      });
    });

    return { available: true, page, session };
  })();

  linksByPage.set(page, link);
  return link;
}

// Each resolveElement() call gets its own stash key, so concurrent calls on
// the same page can't clobber each other's temporary window property between
// the write and the read.
let stashCounter = 0;

/**
 * Resolves one Locator to its current CDP backendNodeId, without touching
 * the DOM: no attribute is set (that would show up as a real change to
 * watchDom, and to anything else observing the page). The element handle is
 * instead stashed in a page-side (window) variable for one round trip, and
 * read back with a raw CDP Runtime.evaluate — which, because the value is an
 * object, returns a Runtime objectId rather than a plain value.
 * DOM.describeNode then turns that objectId into a stable backendNodeId.
 *
 * Returns undefined (not a throw) if the locator doesn't currently match
 * anything, or if CDP isn't available for this page.
 *
 * If `locator` is an `aria-ref=` locator, see resolveRefs()'s doc comment
 * below for a freshness caveat that applies here too.
 */
export async function resolveElement(
  link: CdpLink,
  locator: Locator,
): Promise<number | undefined> {
  if (!link.available) return undefined;
  const { page, session } = link;

  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return undefined;

  const key = `__cdpLinkStash_${stashCounter++}`;
  const objectGroup = key;

  try {
    // Node -> browser: stash the live element under `key` on window. `el` is
    // an ElementHandle nested in the arg array; Playwright hands the page
    // function the real DOM element there, not a serialized copy.
    await page.evaluate(
      ([k, el]) => {
        (window as unknown as Record<string, unknown>)[k] = el;
      },
      [key, handle] as const,
    );

    // Browser -> CDP: read window[key] back as a RemoteObject (not a value,
    // since it's an object), which carries the Runtime objectId we need.
    const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
      expression: `window.${key}`,
      objectGroup,
    });
    if (exceptionDetails || !result.objectId) return undefined;

    const { node } = await session.send("DOM.describeNode", {
      objectId: result.objectId,
    });
    return node.backendNodeId;
  } finally {
    // Clean up both sides: the stashed reference, and the Runtime objectId
    // group it was read into.
    await page
      .evaluate((k) => {
        delete (window as unknown as Record<string, unknown>)[k];
      }, key)
      .catch(() => {});
    await session
      .send("Runtime.releaseObjectGroup", { objectGroup })
      .catch(() => {});
    await handle.dispose().catch(() => {});
  }
}

/**
 * Resolves accessibility-tree refs (the "e12" ids a ariaSnapshot({ mode: "ai"
 * }) snapshot assigns, as read off an entry's parsed tree — see #126) to
 * their current CDP backendNodeId.
 *
 * Not every node in a tree has a ref (text nodes and <option> lines don't,
 * per #126), and a ref can also simply be stale by the time this runs. Both
 * cases are left out of the result rather than thrown, since callers are
 * expected to process whatever refs a tree happened to produce.
 *
 * Caller contract: pass refs read off a snapshot taken immediately before
 * this call, with nothing else async in between — not one read off
 * aria-tree.ts's snapshotTree(), which fires its "content" and "ai" mode
 * snapshots concurrently. A ref minted that way can fail to resolve
 * entirely (count() comes back 0, or elementHandle() hangs out to its
 * timeout) even though the ref id is sitting right there in the snapshot
 * text — as if whichever of the two concurrent snapshots the browser
 * settles second invalidates the other's live ref table. Take a solo
 * `scope.ariaSnapshot({ mode: "ai" })` right before calling this instead.
 */
export async function resolveRefs(
  link: CdpLink,
  refs: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!link.available) return result;

  for (const ref of refs) {
    const locator = link.page.locator(`aria-ref=${ref}`);
    // .count() reads the current DOM without waiting, so an unknown/stale
    // ref is skipped immediately instead of waiting out elementHandle()'s
    // default timeout.
    if ((await locator.count()) === 0) continue;

    const backendNodeId = await resolveElement(link, locator);
    if (backendNodeId !== undefined) result.set(ref, backendNodeId);
  }

  return result;
}
