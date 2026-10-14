// Import only the Locator and TestInfo types from Playwright (no runtime code).
import type { Locator, TestInfo } from "@playwright/test";

// Capture the accessibility tree under `scope` as a YAML-like string.
export async function snapshotTree(scope: Locator): Promise<string> {
  // Ask Playwright for the ARIA snapshot of the scoped element and its descendants.
  return scope.ariaSnapshot();
// End of snapshotTree.
}

// Trim indentation (v1 ignores hierarchy) and drop the trailing ":" that marks children.
function toLines(snapshot: string): string[] {
  // Split into lines, strip whitespace and trailing ":", then remove empty lines.
  return snapshot.split("\n").map((l) => l.trim().replace(/:$/, "")).filter(Boolean);
// End of toLines.
}

// Multiset line diff: counts matter, so duplicate lines are compared as separate items.
export function diffTree(before: string, after: string) {
  // Helper that counts how many times each line appears.
  const count = (lines: string[]) => {
    // Map from line text to number of occurrences.
    const m = new Map<string, number>();
    // Increment the count for each line (starting at 0 if unseen).
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    // Return the finished line counts.
    return m;
  // End of count helper.
  };
  // Line counts for the tree before the change.
  const b = count(toLines(before));
  // Line counts for the tree after the change.
  const a = count(toLines(after));
  // Lines that appear more times after than before.
  const added: string[] = [];
  // Lines that appear more times before than after.
  const removed: string[] = [];
  // For each "after" line, push one copy per extra occurrence beyond the "before" count.
  for (const [line, n] of a) for (let i = b.get(line) ?? 0; i < n; i++) added.push(line);
  // For each "before" line, push one copy per occurrence missing from the "after" count.
  for (const [line, n] of b) for (let i = a.get(line) ?? 0; i < n; i++) removed.push(line);
  // Return both lists together.
  return { added, removed };
// End of diffTree.
}

// Poll until the tree differs from `before` AND is identical on `stableReads` consecutive polls.
export async function waitForTreeChange(
  // The element whose accessibility tree is polled.
  scope: Locator,
  // The snapshot taken before the action; we wait for something different.
  before: string,
  // Options: total timeout, delay between polls, and how many matching reads count as settled.
  { timeoutMs = 5000, intervalMs = 100, stableReads = 3 } = {},
// The function resolves with the settled "after" snapshot.
): Promise<string> {
  // Absolute time after which we give up.
  const deadline = Date.now() + timeoutMs;
  // The most recent snapshot seen, starting with the "before" one.
  let last = before;
  // How many consecutive polls matched the previous (changed) snapshot.
  let sameCount = 0;
  // Keep polling until the deadline passes.
  while (Date.now() < deadline) {
    // Sleep for one polling interval.
    await new Promise((r) => setTimeout(r, intervalMs));
    // Take a fresh snapshot of the tree.
    const now = await scope.ariaSnapshot();
    // Tree hasn't changed from the original yet, so reset the stability counter.
    if (now === before) sameCount = 0;
    // Tree has changed and matches the last poll, so it may be settling.
    else if (now === last) {
      // Count one more consecutive identical read.
      sameCount++;
      // Enough identical reads in a row (the first read plus the repeats): return it.
      if (sameCount >= stableReads - 1) return now;
    // Tree changed again since the last poll, so it's still moving; restart the count.
    } else sameCount = 0;
    // Remember this snapshot for the next comparison.
    last = now;
  // End of polling loop.
  }
  // The tree never changed and settled in time, so fail loudly.
  throw new Error(`waitForTreeChange: tree did not change and settle within ${timeoutMs}ms`);
// End of waitForTreeChange.
}

// Attach the before/after snapshots and the diff to the Playwright test report.
export async function attachTreeDiff(
  // Test metadata (used to attach files) and a label used in the attachment names.
  testInfo: TestInfo, label: string, before: string, after: string,
  // The diff object, typed as whatever diffTree returns.
  diff: ReturnType<typeof diffTree>,
// This function returns nothing; it only writes attachments.
) {
  // Attach the "before" tree as plain text.
  await testInfo.attach(`tree-${label}-before.yaml`, { body: before, contentType: "text/plain" });
  // Attach the "after" tree as plain text.
  await testInfo.attach(`tree-${label}-after.yaml`, { body: after, contentType: "text/plain" });
  // Attach the diff as pretty-printed JSON.
  await testInfo.attach(`tree-${label}-diff.json`, {
    // Serialize the diff with 2-space indentation and mark it as JSON.
    body: JSON.stringify(diff, null, 2), contentType: "application/json",
  // End of the attachment options.
  });
// End of attachTreeDiff.
}
