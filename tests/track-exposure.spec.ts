// Tests for createExposureTracker (#137). All @unit: like crossCheck/diffTrees, the tracker
// is pure logic -- no CDP session, no browser -- so every rule is covered directly against
// hand-built CrossCheckMismatch fixtures. The live-page ACs (showModal() open/close feeding
// real crossCheck() output through a tracker, and classify() labeling the result) are covered
// separately, alongside the rest of X3.4.
import { test, expect } from "@playwright/test";
import { createExposureTracker } from "./helpers/track-exposure";
import { HiddenByBrowser, MissingFromSnapshot } from "./helpers/cross-check";

// Minimal CrossCheckMismatch builders for @unit fixtures -- only the fields a test cares
// about need to be passed. Defaults keep unrelated fields out of each test's way.
function hidden(backendNodeId: number, path: string, reasons: string[] = ["activeModalDialog"]): HiddenByBrowser {
  return { kind: "hiddenByBrowser", path, ref: `e${backendNodeId}`, backendNodeId, reasons };
}
function missing(backendNodeId: number, path: string, role = "listitem"): MissingFromSnapshot {
  return { kind: "missingFromSnapshot", path, backendNodeId, role };
}

test.describe("createExposureTracker: baseline", () => {
  test("the first poll reports no changes and seeds every mismatch it sees as a standing finding", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    const changes = tracker.poll([hidden(10, 'generic "Background"')]);
    expect(changes).toEqual([]);
    expect(tracker.findings()).toEqual([{ backendNodeId: 10, mismatch: hidden(10, 'generic "Background"') }]);
  });

  test("an empty baseline is valid and seeds no standing findings", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    expect(tracker.poll([])).toEqual([]);
    expect(tracker.findings()).toEqual([]);
  });
});

test.describe("createExposureTracker: hidden / exposed", () => {
  test("a mismatch that's new this poll is reported with direction 'hidden'", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"')]);
    const changes = tracker.poll([hidden(10, 'generic "Background"'), hidden(20, 'button "New action"')]);
    expect(changes).toEqual([
      { kind: "exposureChanged", path: 'button "New action"', ref: "e20", backendNodeId: 20, direction: "hidden", reasons: ["activeModalDialog"] },
    ]);
  });

  test("a mismatch that's gone this poll is reported with direction 'exposed'", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"')]);
    const changes = tracker.poll([]);
    expect(changes).toEqual([
      { kind: "exposureChanged", path: 'generic "Background"', ref: "e10", backendNodeId: 10, direction: "exposed", reasons: ["activeModalDialog"] },
    ]);
  });

  test("a missingFromSnapshot-origin change carries no ref and empty reasons", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([missing(30, 'listitem "Item 4"')]);
    const changes = tracker.poll([]);
    expect(changes).toEqual([
      { kind: "exposureChanged", path: 'listitem "Item 4"', backendNodeId: 30, direction: "exposed", reasons: [] },
    ]);
  });

  test("an unrelated mismatch appearing alongside one resolving reports both, independently", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"')]);
    const changes = tracker.poll([hidden(20, 'button "New action"')]);
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: "exposureChanged", path: 'generic "Background"', ref: "e10", backendNodeId: 10, direction: "exposed", reasons: ["activeModalDialog"] },
        { kind: "exposureChanged", path: 'button "New action"', ref: "e20", backendNodeId: 20, direction: "hidden", reasons: ["activeModalDialog"] },
      ]),
    );
    expect(changes).toHaveLength(2);
  });
});

test.describe("createExposureTracker: standing findings", () => {
  test("a mismatch present on every poll since the baseline never appears as a change, and is reported once by findings()", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"')]);
    expect(tracker.poll([hidden(10, 'generic "Background"')])).toEqual([]);
    expect(tracker.poll([hidden(10, 'generic "Background"')])).toEqual([]);
    expect(tracker.findings()).toEqual([{ backendNodeId: 10, mismatch: hidden(10, 'generic "Background"') }]);
  });

  test("a mismatch that has ever changed is not re-admitted as a standing finding, even once it restabilizes", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"')]); // baseline; 10 standing
    tracker.poll([]); // 10 resolves (exposed) -- no longer standing
    const changes = tracker.poll([hidden(10, 'generic "Background"')]); // 10 comes back (hidden again)
    expect(changes).toEqual([
      { kind: "exposureChanged", path: 'generic "Background"', ref: "e10", backendNodeId: 10, direction: "hidden", reasons: ["activeModalDialog"] },
    ]);
    expect(tracker.findings()).toEqual([]);
  });

  test("a mismatch that appears after the baseline is reported as a change but never becomes a standing finding", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([]); // baseline: nothing
    tracker.poll([hidden(10, 'generic "Background"')]); // 10 appears -- a change
    tracker.poll([hidden(10, 'generic "Background"')]); // 10 stays -- no further change
    expect(tracker.findings()).toEqual([]);
  });
});

test.describe("createExposureTracker: identical-copy replace", () => {
  // Same thing #128's mergeReplaced handles for tree diffs: an identical copy swapped into a
  // mismatched node gets a new backendNodeId, which would otherwise look like one mismatch
  // resolving and an unrelated one appearing at the same path with the same reasons.
  test("pairs a same-path, same-reasons hidden/exposed pair in one poll and reports neither", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"')]);
    const changes = tracker.poll([hidden(99, 'generic "Background"')]);
    expect(changes).toEqual([]);
  });

  test("the replacement's new id inherits the old id's standing status", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"')]); // baseline; 10 standing
    tracker.poll([hidden(99, 'generic "Background"')]); // identical copy swapped in
    expect(tracker.findings()).toEqual([{ backendNodeId: 99, mismatch: hidden(99, 'generic "Background"') }]);
  });

  test("a replacement of a mismatch that wasn't standing doesn't manufacture a new standing finding", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([]); // baseline: nothing
    tracker.poll([hidden(10, 'generic "Background"')]); // 10 appears -- a change, not standing
    const changes = tracker.poll([hidden(99, 'generic "Background"')]); // replaced
    expect(changes).toEqual([]);
    expect(tracker.findings()).toEqual([]);
  });

  test("a same-path replacement with different reasons is not paired -- both halves are reported", { tag: "@unit" }, () => {
    const tracker = createExposureTracker();
    tracker.poll([hidden(10, 'generic "Background"', ["activeModalDialog"])]);
    const changes = tracker.poll([hidden(99, 'generic "Background"', ["ariaHiddenElement"])]);
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: "exposureChanged", path: 'generic "Background"', ref: "e10", backendNodeId: 10, direction: "exposed", reasons: ["activeModalDialog"] },
        { kind: "exposureChanged", path: 'generic "Background"', ref: "e99", backendNodeId: 99, direction: "hidden", reasons: ["ariaHiddenElement"] },
      ]),
    );
    expect(changes).toHaveLength(2);
  });
});
