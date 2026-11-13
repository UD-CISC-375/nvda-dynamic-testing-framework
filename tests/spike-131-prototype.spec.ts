import { test, expect, Locator, Page } from '@playwright/test';
import { snapshotTree } from './helpers/aria-tree';
import { parseSnapshot, AriaNode } from './helpers/parse-snapshot';
import { diffTrees } from './helpers/diff-trees';
import { fingerprint } from './helpers/tree-tracker';

/**
 * 無視リスト（neverSettled）に入った ref / path をツリーから除外するフィルタ
 */
function pruneIgnoredNodes(
  nodes: AriaNode[],
  ignoredRefs: Set<string>,
  ignoredPaths: Set<string>,
  parentPath = ''
): AriaNode[] {
  return nodes
    .filter((node) => {
      const label = node.name ? `${node.role} ${JSON.stringify(node.name)}` : node.role;
      const currentPath = parentPath ? `${parentPath} > ${label}` : label;
      if (node.ref && ignoredRefs.has(node.ref)) return false;
      if (ignoredPaths.has(currentPath)) return false;
      return true;
    })
    .map((node) => {
      const label = node.name ? `${node.role} ${JSON.stringify(node.name)}` : node.role;
      const currentPath = parentPath ? `${parentPath} > ${label}` : label;
      return {
        ...node,
        children: pruneIgnoredNodes(node.children, ignoredRefs, ignoredPaths, currentPath),
      };
    });
}

/**
 * Fast Case（< 200ms）対応のポーリング＋自動除外プロトタイプ
 */
async function waitWithNeverSettledPrototype(
  scope: Locator,
  ignoredRefs: Set<string>,
  ignoredPaths: Set<string>,
  lastStablePrint?: string,
  options = { timeoutMs: 5000, intervalMs: 100, stableReads: 3, churnThreshold: 3 }
) {
  const deadline = Date.now() + options.timeoutMs;
  const pollChangeCounts = new Map<string, number>();
  let prevRawTree: AriaNode[] | undefined;
  let prevFilteredPrint: string | undefined;
  let sameCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, options.intervalMs));
    const snap = await snapshotTree(scope);
    const parsed = parseSnapshot(snap);

    if (prevRawTree) {
      const rawChanges = diffTrees(prevRawTree, parsed.tree);
      const changedKeysThisPoll = new Set<string>();

      for (const ch of rawChanges) {
        const key = ch.ref ? `ref:${ch.ref}` : `path:${ch.path}`;
        changedKeysThisPoll.add(key);
        const count = (pollChangeCounts.get(key) ?? 0) + 1;
        pollChangeCounts.set(key, count);

        if (count >= options.churnThreshold) {
          if (ch.ref) ignoredRefs.add(ch.ref);
          ignoredPaths.add(ch.path);
        }
      }

      for (const key of pollChangeCounts.keys()) {
        if (!changedKeysThisPoll.has(key)) {
          pollChangeCounts.set(key, 0);
        }
      }
    }
    prevRawTree = parsed.tree;

    const prunedTree = pruneIgnoredNodes(parsed.tree, ignoredRefs, ignoredPaths);
    const currentPrint = fingerprint(prunedTree);

    if (currentPrint === lastStablePrint) {
      sameCount = 0;
    } else if (currentPrint === prevFilteredPrint) {
      sameCount++;
      if (sameCount >= options.stableReads - 1) {
        return { tree: prunedTree, print: currentPrint };
      }
    } else {
      sameCount = 0;
    }
    prevFilteredPrint = currentPrint;
  }

  throw new Error(`Prototype: did not settle within ${options.timeoutMs}ms`);
}

test.describe('Issue #131 Prototype: Ignore never-settling regions', () => {
  test('Fast Case (50ms ticker) + Button click: 時計を無視してボタンの変化だけ settle できること', async ({ page }) => {
    await page.setContent(`
      <main>
        <h1>Fast Ticker</h1>
        <p>Clock: <span id="clock">0</span></p>
        <button id="reveal">Show Details</button>
        <p id="status">Ready</p>
      </main>
      <script>
        let count = 0;
        setInterval(() => {
          document.getElementById('clock').textContent = String(++count);
        }, 50);
        document.getElementById('reveal').addEventListener('click', () => {
          document.getElementById('status').textContent = 'Details loaded successfully';
        });
      </script>
    `);

    const ignoredRefs = new Set<string>();
    const ignoredPaths = new Set<string>();
    const scope = page.locator('main');

    const baseline = await waitWithNeverSettledPrototype(scope, ignoredRefs, ignoredPaths);
    console.log('[Fast Prototype] Baseline settled! Ignored refs:', [...ignoredRefs], 'Ignored paths:', [...ignoredPaths]);
    expect(ignoredRefs.has('e3')).toBe(true);

    await page.click('#reveal');

    const nextState = await waitWithNeverSettledPrototype(scope, ignoredRefs, ignoredPaths, baseline.print);
    const changes = diffTrees(baseline.tree, nextState.tree);
    console.log('[Fast Prototype] Changes after button click:', JSON.stringify(changes));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'textChanged',
      before: 'Ready',
      after: 'Details loaded successfully',
    });
  });

  test('Slow Case (1000ms ticker) + Button click: 3回の無操作Tickで自動除外し、以降の履歴汚染を防ぐこと', async ({ page }) => {
    await page.setContent(`
      <main>
        <h1>Slow Ticker</h1>
        <p>Clock: <span id="clock">0</span></p>
        <button id="reveal">Show Details</button>
        <p id="status">Ready</p>
      </main>
      <script>
        let count = 0;
        setInterval(() => {
          document.getElementById('clock').textContent = String(++count);
        }, 1000);
        document.getElementById('reveal').addEventListener('click', () => {
          document.getElementById('status').textContent = 'Details loaded successfully';
        });
      </script>
    `);

    const ignoredRefs = new Set<string>();
    const ignoredPaths = new Set<string>();
    const unpromptedEntryCounts = new Map<string, number>();
    const scope = page.locator('main');

    let current = await waitWithNeverSettledPrototype(scope, ignoredRefs, ignoredPaths);

    // ユーザー操作なしで3回分のTickを観測 → 3回目で neverSettled に登録
    for (let tick = 1; tick <= 3; tick++) {
      const next = await waitWithNeverSettledPrototype(scope, ignoredRefs, ignoredPaths, current.print);
      const diffs = diffTrees(current.tree, next.tree);
      for (const d of diffs) {
        const key = d.ref ? `ref:${d.ref}` : `path:${d.path}`;
        const count = (unpromptedEntryCounts.get(key) ?? 0) + 1;
        unpromptedEntryCounts.set(key, count);
        if (count >= 3) {
          if (d.ref) ignoredRefs.add(d.ref);
          ignoredPaths.add(d.path);
          console.log(`[Slow Prototype] Flagged neverSettled on tick #${tick}: ${key} (${d.path})`);
        }
      }
      current = {
        tree: pruneIgnoredNodes(next.tree, ignoredRefs, ignoredPaths),
        print: fingerprint(pruneIgnoredNodes(next.tree, ignoredRefs, ignoredPaths)),
      };
    }

    expect(ignoredRefs.has('e3')).toBe(true);

    // 除外後にユーザーがボタンをクリック → 時計ではなくボタンの変更だけを検知
    await page.click('#reveal');
    const afterClick = await waitWithNeverSettledPrototype(scope, ignoredRefs, ignoredPaths, current.print);
    const clickChanges = diffTrees(current.tree, afterClick.tree);
    console.log('[Slow Prototype] Changes after button click:', JSON.stringify(clickChanges));

    expect(clickChanges).toHaveLength(1);
    expect(clickChanges[0]).toMatchObject({
      kind: 'textChanged',
      before: 'Ready',
      after: 'Details loaded successfully',
    });
  });
});