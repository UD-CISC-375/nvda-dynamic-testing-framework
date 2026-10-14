import type { Locator, TestInfo } from "@playwright/test";

export async function snapshotTree(scope: Locator): Promise<string> {
  return scope.ariaSnapshot();
}

// Trim indentation (v1 ignores hierarchy) and drop the trailing ":" that marks children.
function toLines(snapshot: string): string[] {
  return snapshot.split("\n").map((l) => l.trim().replace(/:$/, "")).filter(Boolean);
}

// Multiset line diff: counts matter, so duplicate lines are compared as separate items.
export function diffTree(before: string, after: string) {
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const b = count(toLines(before));
  const a = count(toLines(after));
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, n] of a) for (let i = b.get(line) ?? 0; i < n; i++) added.push(line);
  for (const [line, n] of b) for (let i = a.get(line) ?? 0; i < n; i++) removed.push(line);
  return { added, removed };
}

// Poll until the tree differs from `before` AND is identical on `stableReads` consecutive polls.
export async function waitForTreeChange(
  scope: Locator,
  before: string,
  { timeoutMs = 5000, intervalMs = 100, stableReads = 3 } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = before;
  let sameCount = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const now = await scope.ariaSnapshot();
    if (now === before) sameCount = 0;
    else if (now === last) {
      sameCount++;
      if (sameCount >= stableReads - 1) return now;
    } else sameCount = 0;
    last = now;
  }
  throw new Error(`waitForTreeChange: tree did not change and settle within ${timeoutMs}ms`);
}

export async function attachTreeDiff(
  testInfo: TestInfo, label: string, before: string, after: string,
  diff: ReturnType<typeof diffTree>,
) {
  await testInfo.attach(`tree-${label}-before.yaml`, { body: before, contentType: "text/plain" });
  await testInfo.attach(`tree-${label}-after.yaml`, { body: after, contentType: "text/plain" });
  await testInfo.attach(`tree-${label}-diff.json`, {
    body: JSON.stringify(diff, null, 2), contentType: "application/json",
  });
}
