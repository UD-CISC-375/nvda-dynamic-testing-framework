import { test, expect } from "@playwright/test";
import {
  actualFromError,
  diffIntendedAndActual,
  generateRemediation,
  parseDeveloperAnnotations,
  parseIntendedState,
  parseTriggerSelector,
  shouldOpenReport,
  stripAnsi,
  toHtml,
  toMarkdown,
  type ReportModel,
} from "../accessible-markdown-reporter";
import { captureAccessibleState } from "./helpers/annotations";
import { isolatedAccordionUrl } from "./helpers/isolated-pages";

const SAMPLE_SOURCE = `/**
 * Component Name: Accordion Section
 * Selector: #accordion-panel
 * Trigger Event: Click on button#accordion-header-btn
 * Intended State: aria-expanded="true", aria-controls
 * Expected Speech: "Expanded" or "Collapsed"
 */`;

const sampleAnnotations = parseDeveloperAnnotations(SAMPLE_SOURCE);
const failingDiff = diffIntendedAndActual(sampleAnnotations, {
  trigger: {
    found: true,
    selector: "button#accordion-header-btn",
    attributes: { "aria-expanded": null, "aria-controls": null },
  },
});

const model: ReportModel = {
  runStatus: "failed",
  durationMs: 1540,
  passed: 1,
  failed: 1,
  skipped: 0,
  interrupted: 0,
  tests: [
    {
      id: "passed-test",
      title: "isolated broken accordion page loads",
      file: "tests/accordion-isolated.spec.ts",
      project: "chromium",
      status: "passed",
      durationMs: 220,
      annotations: sampleAnnotations,
      stateDiff: [],
      remediationItems: generateRemediation("passed"),
    },
    {
      id: "failed-test",
      title: "broken: header click sets aria-expanded and aria-controls",
      file: "tests/accordion-isolated.spec.ts",
      project: "chromium",
      status: "failed",
      durationMs: 410,
      annotations: sampleAnnotations,
      stateDiff: failingDiff,
      error:
        'Error: expect(locator).toHaveAttribute("aria-expanded") failed\nReceived: null',
      output: "clicked #accordion-header-btn",
      remediationItems: generateRemediation(
        "failed",
        failingDiff,
        {
          trigger: {
            found: true,
            selector: "button#accordion-header-btn",
            attributes: { "aria-expanded": null, "aria-controls": null },
          },
          content: {
            images: [{ alt: "image of a collapsed accordion" }],
          },
        },
      ),
    },
  ],
};

test("parses the five developer annotations from a JSDoc block", () => {
  expect(parseDeveloperAnnotations(SAMPLE_SOURCE)).toEqual({
    componentName: "Accordion Section",
    selector: "#accordion-panel",
    triggerEvent: "Click on button#accordion-header-btn",
    intendedState: 'aria-expanded="true", aria-controls',
    expectedSpeech: '"Expanded" or "Collapsed"',
  });
});

test("parses trigger selector and intended-state tokens from annotations", () => {
  expect(parseTriggerSelector(sampleAnnotations.triggerEvent)).toBe(
    "button#accordion-header-btn",
  );
  expect(parseIntendedState(sampleAnnotations.intendedState)).toEqual([
    { name: "aria-expanded", expected: "true" },
    { name: "aria-controls", expected: null },
  ]);
});

test("automated remediation engine reports ARIA and alt-text issues", () => {
  const items = generateRemediation("failed", failingDiff, {
    trigger: {
      found: true,
      selector: "button#accordion-header-btn",
      attributes: { "aria-expanded": null, "aria-controls": null },
    },
    content: {
      images: [{ alt: "picture of a warning icon" }],
    },
  });
  expect(items.some((item) => item.kind === "aria" && item.message.includes("aria-expanded"))).toBe(
    true,
  );
  expect(items.some((item) => item.kind === "aria" && item.message.includes("aria-controls"))).toBe(
    true,
  );
  expect(items.some((item) => item.kind === "alt-text")).toBe(true);
  expect(items.map((item) => item.message).join(" ")).not.toContain("Expected Speech");
  expect(items.map((item) => item.message).join(" ")).not.toMatch(/Flesch/i);
});

test("widget state is read from the trigger, not the panel", () => {
  const diff = diffIntendedAndActual(sampleAnnotations, {
    trigger: {
      found: true,
      selector: "button#accordion-header-btn",
      attributes: {},
    },
    target: {
      found: true,
      selector: "#accordion-panel",
      attributes: {
        "aria-expanded": "true",
        "aria-controls": "accordion-panel",
        id: "accordion-panel",
      },
    },
  });
  expect(diff.find((row) => row.attribute === "aria-expanded")).toEqual({
    attribute: "aria-expanded",
    intended: "true",
    actual: "(absent)",
    match: false,
  });
  expect(diff.find((row) => row.attribute === "aria-controls")?.actual).toBe(
    "(absent)",
  );
});

test("reads widget attributes from the annotated selector when the trigger snapshot omits them", () => {
  const annotations = {
    ...sampleAnnotations,
    selector: "button#acc-header-1",
    triggerEvent: "Click on button#acc-header-1",
  };
  const fromTarget = diffIntendedAndActual(annotations, {
    trigger: {
      found: false,
      selector: "button#acc-header-1",
      attributes: {},
    },
    target: {
      found: true,
      selector: "button#acc-header-1",
      attributes: {
        "aria-expanded": "true",
        "aria-controls": "acc-panel-1",
      },
    },
  });
  expect(fromTarget.find((row) => row.attribute === "aria-expanded")?.actual).toBe(
    "true",
  );
  expect(fromTarget.find((row) => row.attribute === "aria-controls")?.actual).toBe(
    "acc-panel-1",
  );

  const triggerPresentButEmpty = diffIntendedAndActual(annotations, {
    trigger: {
      found: true,
      selector: "button#acc-header-1",
      attributes: {},
    },
    target: {
      found: true,
      selector: "button#acc-header-1",
      attributes: {
        "aria-expanded": "true",
        "aria-controls": "acc-panel-1",
      },
    },
  });
  expect(
    triggerPresentButEmpty.find((row) => row.attribute === "aria-expanded")
      ?.actual,
  ).toBe("true");
});

test("reads aria-expanded and aria-controls from an interactive selector", () => {
  const annotations = {
    ...sampleAnnotations,
    selector: "button#acc-header-1",
    triggerEvent: "Click on button#acc-header-1",
  };
  const diff = diffIntendedAndActual(annotations, {
    trigger: {
      found: true,
      selector: "button#acc-header-1",
      attributes: {
        "aria-expanded": "true",
        "aria-controls": "acc-panel-1",
        id: "acc-header-1",
      },
    },
    target: {
      found: true,
      selector: "button#acc-header-1",
      attributes: {
        "aria-expanded": "true",
        "aria-controls": "acc-panel-1",
        id: "acc-header-1",
      },
    },
  });
  expect(diff.find((row) => row.attribute === "aria-expanded")).toEqual({
    attribute: "aria-expanded",
    intended: "true",
    actual: "true",
    match: true,
  });
  expect(diff.find((row) => row.attribute === "aria-controls")).toEqual({
    attribute: "aria-controls",
    intended: "(present)",
    actual: "acc-panel-1",
    match: true,
  });
});

test("does not require aria-expanded=true during page load", () => {
  const loadDiff = diffIntendedAndActual(
    sampleAnnotations,
    {
      trigger: {
        found: true,
        selector: "button#accordion-header-btn",
        attributes: {
          "aria-expanded": "false",
          "aria-controls": "accordion-panel",
        },
      },
    },
    "load",
  );
  expect(loadDiff.some((row) => row.attribute === "aria-expanded")).toBe(false);
  expect(loadDiff.find((row) => row.attribute === "aria-controls")?.match).toBe(
    true,
  );
  expect(diffIntendedAndActual(sampleAnnotations, undefined, "after-trigger")).toEqual(
    [],
  );
});

test("diffs intended annotation state against a missing-ARIA DOM snapshot", () => {
  expect(failingDiff).toEqual([
    {
      attribute: "aria-expanded",
      intended: "true",
      actual: "(absent)",
      match: false,
    },
    {
      attribute: "aria-controls",
      intended: "(present)",
      actual: "(absent)",
      match: false,
    },
  ]);
  expect(
    actualFromError(
      'Error: expect(locator).toHaveAttribute("aria-expanded") failed\nReceived: null',
    )?.trigger?.attributes["aria-expanded"],
  ).toBeNull();
});

test("markdown report includes status, duration, annotations, and remediation", () => {
  const markdown = toMarkdown(model);
  expect(markdown).toContain("**Run status:** failed");
  expect(markdown).toContain("**Duration:** 1.5s");
  expect(markdown).toContain("| Component Name | Accordion Section |");
  expect(markdown).toContain("| Selector | #accordion-panel |");
  expect(markdown).toContain(
    "| Trigger Event | Click on button#accordion-header-btn |",
  );
  expect(markdown).toContain(
    '| Intended State | aria-expanded="true", aria-controls |',
  );
  expect(markdown).toContain('| Expected Speech | "Expanded" or "Collapsed" |');
  expect(markdown).toContain("Intended vs actual DOM state");
  expect(markdown).toContain("| aria-expanded | true | (absent) | No |");
  expect(markdown).toContain("### Automated remediation");
  expect(markdown).toContain("Missing aria-expanded");
  expect(markdown).toContain("Redundant alt text");
  expect(markdown).not.toMatch(/Flesch/i);
  expect(markdown).toMatch(/\| Expected Speech \|/);
  expect(markdown).not.toMatch(/^- .*Expected Speech/m);
});

test("strips ANSI escape codes from error messages and logs", () => {
  const coloredError =
    "\u001b[31mError: \u001b[39m\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoHaveAttribute\u001b[2m(\u001b[22m\u001b[32mreceived\u001b[39m\u001b[2m)\u001b[22m failed\nReceived: \u001b[32mnull\u001b[39m";
  const coloredOutput = "\u001b[1mclicked\u001b[22m #accordion-header-btn";

  expect(stripAnsi(coloredError)).toBe(
    "Error: expect(locator).toHaveAttribute(received) failed\nReceived: null",
  );
  expect(stripAnsi(coloredOutput)).toBe("clicked #accordion-header-btn");
  expect(stripAnsi("\u001b[31mError\u001b[39m")).toBe("Error");

  const coloredModel: ReportModel = {
    ...model,
    tests: [
      {
        ...model.tests[1],
        error: coloredError,
        output: coloredOutput,
      },
    ],
  };
  const markdown = toMarkdown(coloredModel);
  expect(markdown).toContain("### Error / diff");
  expect(markdown).toContain(
    "Error: expect(locator).toHaveAttribute(received) failed",
  );
  expect(markdown).toContain("clicked #accordion-header-btn");
  expect(markdown).not.toMatch(/\u001B|\u009B/);
  expect(markdown).not.toContain("[31m");
  expect(markdown).not.toContain("[39m");
  expect(markdown).not.toContain("[2m");

  const html = toHtml(coloredModel);
  expect(html).toContain("Error / diff");
  expect(html).toContain(
    "Error: expect(locator).toHaveAttribute(received) failed",
  );
  expect(html).toContain("clicked #accordion-header-btn");
  expect(html).not.toMatch(/\u001B|\u009B/);
  expect(html).not.toContain("[31m");
  expect(html).not.toContain("[2m");
});

test("opens the accessible report locally unless CI or open=never", () => {
  expect(shouldOpenReport("always", "passed")).toBe(true);
  expect(shouldOpenReport("never", "failed")).toBe(false);
  expect(shouldOpenReport("on-failure", "passed")).toBe(false);
  expect(shouldOpenReport("on-failure", "failed")).toBe(true);
  expect(shouldOpenReport(undefined, "passed", true)).toBe(false);
  expect(shouldOpenReport(undefined, "passed", false)).toBe(true);
});

test("html report includes dual-view toggle and accessible disclosure markup", () => {
  const html = toHtml(model);
  expect(html).toContain('role="tablist"');
  expect(html).toContain('role="tab"');
  expect(html).toContain('role="tabpanel"');
  expect(html).toContain('aria-label="Report view"');
  expect(html).toContain('id="view-graphical"');
  expect(html).toContain('id="view-markdown"');
  expect(html).toContain('aria-controls="graphical-view"');
  expect(html).toContain('aria-controls="markdown-view"');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Test results");
  expect(html).not.toContain("Error and diff details");
  expect(html).toContain("<article");
  expect(html).toContain("<h2");
  expect(html).toContain("<h3");
  expect(html).toContain("Component Name");
  expect(html).toContain("Automated remediation");
  expect(html).toContain("anno-pane");
  expect(html).toContain("remediation-pane");
  expect(html).toContain("split");
  expect(html).toContain("Intended vs actual DOM state");
  expect(html).toContain("mismatch");
  expect(html).toContain("Redundant alt text");
  const resultsAt = html.indexOf("Test results");
  const annotationsAt = html.indexOf("Developer annotations");
  const failedCardAt = html.indexOf('data-testid="test-card-1"');
  const failedCardEnd = html.indexOf("</article>", failedCardAt);
  const errorButtonAt = html.indexOf("Error / diff");
  const passedCardAt = html.indexOf('data-testid="test-card-0"');
  const passedCardEnd = html.indexOf("</article>", passedCardAt);
  expect(resultsAt).toBeGreaterThan(-1);
  expect(annotationsAt).toBeGreaterThan(resultsAt);
  expect(errorButtonAt).toBeGreaterThan(failedCardAt);
  expect(errorButtonAt).toBeLessThan(failedCardEnd);
  expect(html.slice(passedCardAt, passedCardEnd)).not.toContain("Error / diff");
});

test("dual-view toggle switches views and announces the change", async ({
  page,
}) => {
  await page.setContent(toHtml(model));

  const graphical = page.getByTestId("view-graphical");
  const markdown = page.getByTestId("view-markdown");
  await expect(graphical).toHaveAttribute("role", "tab");
  await expect(graphical).toHaveAttribute("aria-selected", "true");
  await expect(graphical).toHaveAttribute("tabindex", "0");
  await expect(markdown).toHaveAttribute("aria-selected", "false");
  await expect(markdown).toHaveAttribute("tabindex", "-1");
  await expect(page.getByTestId("graphical-view")).toBeVisible();
  await expect(page.getByTestId("markdown-view")).toBeHidden();
  await expect(page.getByTestId("view-live")).toHaveText(
    "Standard graphical view selected",
  );

  await markdown.click();
  await expect(markdown).toHaveAttribute("aria-selected", "true");
  await expect(markdown).toHaveAttribute("tabindex", "0");
  await expect(graphical).toHaveAttribute("aria-selected", "false");
  await expect(graphical).toHaveAttribute("tabindex", "-1");
  await expect(page.getByTestId("markdown-view")).toBeVisible();
  await expect(page.getByTestId("graphical-view")).toBeHidden();
  await expect(page.getByTestId("view-live")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(page.getByTestId("view-live")).toHaveText(
    "Accessible Markdown source view selected",
  );

  await graphical.click();
  await expect(graphical).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("graphical-view")).toBeVisible();
  await expect(page.getByTestId("view-live")).toHaveText(
    "Standard graphical view selected",
  );

  await graphical.press("ArrowRight");
  await expect(markdown).toHaveAttribute("aria-selected", "true");
  await expect(markdown).toBeFocused();
  await expect(page.getByTestId("markdown-view")).toBeVisible();
});

test("collapsible sections update aria-expanded, aria-controls, and live text", async ({
  page,
}) => {
  await page.setContent(toHtml(model));

  const annotations = page.getByRole("heading", { name: "Developer annotations" }).first();
  const remediation = page.getByRole("heading", { name: "Automated remediation" }).first();
  const errorToggle = page
    .getByTestId("test-card-1")
    .getByRole("button", { name: "Error / diff" });
  const panelId = await errorToggle.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  await expect(annotations).toBeVisible();
  await expect(remediation).toBeVisible();
  await expect(errorToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`#${panelId}`)).toBeHidden();
  await expect(page.getByRole("table")).toContainText("aria-expanded");

  await errorToggle.click();
  await expect(errorToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`#${panelId}`)).toBeVisible();
  await expect(page.locator(`#${panelId}`)).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(page.getByTestId("section-live")).toHaveText(
    "Error / diff expanded",
  );

  await errorToggle.press("Enter");
  await expect(errorToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("section-live")).toHaveText(
    "Error / diff collapsed",
  );

  await errorToggle.press(" ");
  await expect(errorToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("section-live")).toHaveText(
    "Error / diff expanded",
  );
});

test("report source order and headings follow the visual layout", async ({
  page,
}) => {
  await page.setContent(toHtml(model));

  const headings = await page.locator("h1, h2, h3, h4").allTextContents();
  expect(headings[0]).toBe("Accessible test report");
  expect(headings[1]).toBe("Test results");
  expect(headings).toContain("Developer annotations");
  expect(headings).toContain("Automated remediation");
  expect(headings).not.toContain("Error and diff details");

  const firstCard = page.getByTestId("test-card-0");
  const failedCard = page.getByTestId("test-card-1");
  const errorToggle = failedCard.getByRole("button", { name: "Error / diff" });
  const remediation = failedCard.getByRole("heading", {
    name: "Automated remediation",
  });
  await expect(firstCard).toBeVisible();
  await expect(firstCard.getByRole("button", { name: "Error / diff" })).toHaveCount(0);
  await expect(errorToggle).toBeVisible();
  const cardBox = await firstCard.boundingBox();
  const remediationBox = await remediation.boundingBox();
  const errorBox = await errorToggle.boundingBox();
  expect(cardBox && errorBox && cardBox.y < errorBox.y).toBe(true);
  expect(remediationBox && errorBox && remediationBox.y < errorBox.y).toBe(true);
});

test("keyboard focus moves through view tabs, test cards, then error blocks", async ({
  page,
}) => {
  await page.setContent(toHtml(model));
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to report" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("view-graphical")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("test-card-0")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("test-card-1")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByTestId("test-card-1").getByRole("button", { name: "Error / diff" }),
  ).toBeFocused();
});

test("captures actual DOM attributes for annotation comparison", async ({
  page,
}) => {
  await page.setContent(`
    <button id="accordion-header-btn">Section</button>
    <div id="accordion-panel" hidden>Panel</div>
  `);
  const actual = await captureAccessibleState(page, sampleAnnotations);
  expect(actual.trigger?.found).toBe(true);
  expect(actual.trigger?.attributes["aria-expanded"]).toBeUndefined();
  expect(actual.target?.found).toBe(true);
  expect(
    diffIntendedAndActual(sampleAnnotations, actual, "after-trigger").every(
      (row) => !row.match,
    ),
  ).toBe(true);
});

test("broken accordion snapshot still generates intended-vs-actual remediation", async ({
  page,
}) => {
  await page.goto(isolatedAccordionUrl());
  await page.locator("button#accordion-header-btn").click();
  const actual = await captureAccessibleState(page, sampleAnnotations);
  const diff = diffIntendedAndActual(sampleAnnotations, actual, "after-trigger");
  expect(diff.find((row) => row.attribute === "aria-expanded")).toEqual({
    attribute: "aria-expanded",
    intended: "true",
    actual: "(absent)",
    match: false,
  });
  expect(diff.find((row) => row.attribute === "aria-controls")?.match).toBe(
    false,
  );
  const items = generateRemediation("failed", diff, actual);
  expect(
    items.some(
      (item) => item.kind === "aria" && item.message.includes("aria-expanded"),
    ),
  ).toBe(true);
  expect(
    items.some(
      (item) => item.kind === "aria" && item.message.includes("aria-controls"),
    ),
  ).toBe(true);
  const markdown = toMarkdown({
    ...model,
    tests: [
      {
        ...model.tests[1],
        actualState: actual,
        stateDiff: diff,
        remediationItems: items,
      },
    ],
  });
  expect(markdown).toContain("Intended vs actual DOM state");
  expect(markdown).toContain("| aria-expanded | true | (absent) | No |");
  expect(markdown).toContain("Missing aria-expanded");
});

test("captures React-style attributes from the annotated button selector", async ({
  page,
}) => {
  await page.setContent(`
    <button id="acc-header-1" aria-expanded="true" aria-controls="acc-panel-1">What is NVDA?</button>
    <div id="acc-panel-1">NVDA is a screen reader.</div>
  `);
  const annotations = {
    ...sampleAnnotations,
    selector: "button#acc-header-1",
    triggerEvent: "Click on button#acc-header-1",
  };
  const actual = await captureAccessibleState(page, annotations);
  expect(actual.trigger?.attributes["aria-expanded"]).toBe("true");
  expect(actual.trigger?.attributes["aria-controls"]).toBe("acc-panel-1");
  expect(
    diffIntendedAndActual(annotations, actual, "after-trigger").every(
      (row) => row.match,
    ),
  ).toBe(true);
});
