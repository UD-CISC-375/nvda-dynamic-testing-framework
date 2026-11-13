import { test, expect } from '@playwright/test';
import path from 'path';
import { createTreeTracker } from './helpers/tree-tracker';

test.describe('Issue #131: Never-settling regions (Current Behavior)', () => {
  // 1. Slow Case (1000ms間隔): 既存の tests/fixtures/ticker.html を使用
  test('Slow Case: 1秒ごとに新しい Entry が履歴に溜まり続ける現象の実測', async ({ page }) => {
    const filePath = path.resolve(__dirname, 'fixtures/ticker.html');
    await page.goto(`file://${filePath}`);

    const tracker = await createTreeTracker(page, page.locator('main'));
    console.log('--- [Slow Case] Baseline recorded ---');
    console.log('Initial history length:', tracker.history().length);

    // ユーザー操作を一切せずに next() を3回呼ぶと、時計の1秒ごとの更新を拾ってしまい3回とも成功（新しいEntry生成）してしまう
    for (let i = 1; i <= 3; i++) {
      const entry = await tracker.next();
      console.log(`Tick #${i} -> entry.index=${entry.index}, stateIndex=${entry.stateIndex}, newState=${entry.newState}, meaningful=${entry.meaningful}`);
      console.log('  diff:', JSON.stringify(entry.diff));
    }

    expect(tracker.history().length).toBe(4); // Baseline + 3 ticks
  });

  // 2. Fast Case (50ms間隔): 200msの settle window より速く変化し続ける場合
  test('Fast Case: 50ms間隔の更新では一度も settle できずタイムアウトする現象の実測', async ({ page }) => {
    await page.setContent(`
      <main>
        <h1>Fast Ticker</h1>
        <p>Count: <span id="clock">0</span></p>
        <button id="btn">Click me</button>
      </main>
      <script>
        let count = 0;
        setInterval(() => {
          count++;
          document.getElementById('clock').textContent = String(count);
        }, 50);
      </script>
    `);

    console.log('--- [Fast Case] Starting createTreeTracker (expect timeout) ---');
    const start = Date.now();
    let errorMessage = '';

    try {
      // baseline の取得すら waitForSettled が完了せず 2000ms でタイムアウトするはず
      await createTreeTracker(page, page.locator('main'), { timeoutMs: 2000 });
    } catch (err: any) {
      errorMessage = err.message;
    }

    const elapsed = Date.now() - start;
    console.log(`Fast Case failed after ${elapsed}ms with error: "${errorMessage}"`);
    expect(errorMessage).toContain('waitForSettled: no settled change within 2000ms');
  });
});