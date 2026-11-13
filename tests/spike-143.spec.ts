import { test, expect } from '@playwright/test';
import { createTreeTracker } from './helpers/tree-tracker';
import { snapshotTree } from './helpers/aria-tree';
import type { DomChange } from './helpers/watch-dom';

/**
 * プロトタイプ：settle する前に消えた変化（または ariaSnapshot に映らない aria-busy）を
 * watchDom のミューテーション履歴から検出・分類するヘルパー
 */
function detectBriefChanges(domChanges: DomChange[]) {
  const briefEvents: Array<{
    kind: 'briefLiveRegion' | 'ariaBusyFlip' | 'silentTransientDom';
    target: string;
    detail: string;
    screenReaderAnnounced: boolean;
  }> = [];

  // 1. aria-busy の変化を検出
  const busyChanges = domChanges.filter(
    (c) => c.type === 'attributes' && c.attributeName === 'aria-busy'
  );
  if (busyChanges.length > 0) {
    briefEvents.push({
      kind: 'ariaBusyFlip',
      target: busyChanges[0].target,
      detail: `aria-busy: ${busyChanges.map((b) => `${b.oldValue}->${b.newValue}`).join(', ')}`,
      screenReaderAnnounced: true,
    });
  }

  // 2. 追加された直後に削除された要素（一瞬だけ現れて消えた要素）を検出
  const addedList = domChanges.filter((c) => c.type === 'childList' && c.added.length > 0);
  const removedList = domChanges.filter((c) => c.type === 'childList' && c.removed.length > 0);

  if (addedList.length > 0 && removedList.length > 0) {
    for (const added of addedList) {
      // inLiveRegion フラグ、または role="status" / role="alert" を持つか判定
      const isAnnounced = added.inLiveRegion || Boolean(added.text && added.text.trim().length > 0);
      briefEvents.push({
        kind: added.inLiveRegion ? 'briefLiveRegion' : 'silentTransientDom',
        target: added.target,
        detail: `added [${added.added.join(',')}] text="${added.text ?? ''}" then removed`,
        screenReaderAnnounced: isAnnounced,
      });
    }
  }

  return briefEvents;
}

test.describe('Issue #143: Changes that come and go before settling', () => {
  // Case 1: 約200msだけ表示されて消える要素（ポーリングには1〜2回映るが settle せず破棄される）
  test('Case 1: 200ms element (seen by poll, then discarded -> no entry)', async ({ page }) => {
    await page.setContent(`
      <main>
        <h1>Brief Change 200ms</h1>
        <button id="trigger">Show 200ms Spinner</button>
        <div id="host" aria-live="polite"></div>
      </main>
      <script>
        document.getElementById('trigger').addEventListener('click', () => {
          const el = document.createElement('div');
          el.setAttribute('role', 'status');
          el.textContent = 'Loading 200ms...';
          document.getElementById('host').appendChild(el);
          setTimeout(() => el.remove(), 200);
        });
      </script>
    `);

    // 事前にボタンへフォーカスしておき、クリック時のフォーカス移動ノイズを除外
    await page.focus('#trigger');
    const tracker = await createTreeTracker(page, page.locator('main'), { timeoutMs: 1200 });
    const beforeWatchCount = tracker.watcher.changes.length;

    const pollObservations: string[] = [];
    const pollMonitor = (async () => {
      for (let i = 1; i <= 4; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const snap = await snapshotTree(page.locator('main'));
        pollObservations.push(
          `poll#${i}(${i * 100}ms): sawSpinner=${snap.content.includes('Loading 200ms...')}`
        );
      }
    })();

    await page.click('#trigger');

    let entryCreated = false;
    let trackerError = '';
    try {
      await tracker.next({ timeoutMs: 1200 });
      entryCreated = true;
    } catch (err: any) {
      trackerError = err.message;
    }
    await pollMonitor;

    const newDomChanges = tracker.watcher.changes.slice(beforeWatchCount);
    const briefDetected = detectBriefChanges(newDomChanges);

    console.log('=== [Case 1: 200ms Element] ===');
    console.log('1. watchDom records:', JSON.stringify(newDomChanges));
    console.log('2. Poll observations:', pollObservations);
    console.log('3. Tracker made entry?:', entryCreated, '| Error:', trackerError);
    console.log('4. Prototype brief detection:', JSON.stringify(briefDetected));

    expect(entryCreated).toBe(false);
    expect(briefDetected[0]?.kind).toBe('briefLiveRegion');
  });

  // Case 2: 約50msだけ表示されて消える要素（100msポーリングの隙間で消え、ツリーには一度も映らない）
  test('Case 2: 50ms element (never seen by tree polls -> only watchDom records)', async ({ page }) => {
    await page.setContent(`
      <main>
        <h1>Brief Change 50ms</h1>
        <button id="trigger">Show 50ms Toast</button>
        <div id="host" aria-live="assertive"></div>
      </main>
      <script>
        document.getElementById('trigger').addEventListener('click', () => {
          const el = document.createElement('div');
          el.setAttribute('role', 'alert');
          el.textContent = 'Saved 50ms!';
          document.getElementById('host').appendChild(el);
          setTimeout(() => el.remove(), 50);
        });
      </script>
    `);

    await page.focus('#trigger');
    const tracker = await createTreeTracker(page, page.locator('main'), { timeoutMs: 1200 });
    const beforeWatchCount = tracker.watcher.changes.length;

    const pollObservations: string[] = [];
    const pollMonitor = (async () => {
      for (let i = 1; i <= 4; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const snap = await snapshotTree(page.locator('main'));
        pollObservations.push(
          `poll#${i}(${i * 100}ms): sawToast=${snap.content.includes('Saved 50ms!')}`
        );
      }
    })();

    await page.click('#trigger');

    let entryCreated = false;
    let trackerError = '';
    try {
      await tracker.next({ timeoutMs: 1200 });
      entryCreated = true;
    } catch (err: any) {
      trackerError = err.message;
    }
    await pollMonitor;

    const newDomChanges = tracker.watcher.changes.slice(beforeWatchCount);
    const briefDetected = detectBriefChanges(newDomChanges);

    console.log('=== [Case 2: 50ms Element] ===');
    console.log('1. watchDom records:', JSON.stringify(newDomChanges));
    console.log('2. Poll observations:', pollObservations);
    console.log('3. Tracker made entry?:', entryCreated, '| Error:', trackerError);
    console.log('4. Prototype brief detection:', JSON.stringify(briefDetected));

    expect(entryCreated).toBe(false);
    expect(briefDetected[0]?.kind).toBe('briefLiveRegion');
  });

  // Case 3: aria-busy が true になり、その後 false に戻る変化（ツリーには一切現れない）
  test('Case 3: aria-busy flips true then false (invisible to ariaSnapshot -> no entry)', async ({ page }) => {
    await page.setContent(`
      <main>
        <h1>Aria Busy Flip</h1>
        <button id="trigger">Toggle Busy</button>
        <section id="panel" aria-busy="false">Content stays identical</section>
      </main>
      <script>
        document.getElementById('trigger').addEventListener('click', () => {
          const panel = document.getElementById('panel');
          panel.setAttribute('aria-busy', 'true');
          setTimeout(() => panel.setAttribute('aria-busy', 'false'), 400);
        });
      </script>
    `);

    await page.focus('#trigger');
    const tracker = await createTreeTracker(page, page.locator('main'), { timeoutMs: 1200 });
    const beforeWatchCount = tracker.watcher.changes.length;

    await page.click('#trigger');
    await new Promise((r) => setTimeout(r, 100));
    const snapDuringBusy = await snapshotTree(page.locator('main'));

    let entryCreated = false;
    let trackerError = '';
    try {
      await tracker.next({ timeoutMs: 1200 });
      entryCreated = true;
    } catch (err: any) {
      trackerError = err.message;
    }

    const newDomChanges = tracker.watcher.changes.slice(beforeWatchCount);
    const briefDetected = detectBriefChanges(newDomChanges);

    console.log('=== [Case 3: aria-busy Flip] ===');
    console.log('1. watchDom records:', JSON.stringify(newDomChanges));
    console.log('2. Tree snapshot while busy=true:', JSON.stringify(snapDuringBusy.content));
    console.log('3. Tracker made entry?:', entryCreated, '| Error:', trackerError);
    console.log('4. Prototype brief detection:', JSON.stringify(briefDetected));

    expect(snapDuringBusy.content).not.toContain('busy');
    expect(entryCreated).toBe(false);
    expect(briefDetected[0]?.kind).toBe('ariaBusyFlip');
  });
});