import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

export type ReporterOptions = {
  outputFile?: string;
  open?: "always" | "never" | "on-failure";
};

export const ANNOTATION_EVAL_ATTACHMENT = "annotation-eval.json";

export type DeveloperAnnotations = {
  componentName?: string;
  selector?: string;
  triggerEvent?: string;
  intendedState?: string;
  expectedSpeech?: string;
};

export type IntendedAttribute = {
  name: string;
  expected: string | null;
};

export type ActualDomSnapshot = {
  found: boolean;
  selector?: string;
  attributes: Record<string, string | null>;
};

export type ContentScan = {
  images: Array<{ alt: string; selector?: string }>;
};

export type ActualDomState = {
  trigger?: ActualDomSnapshot;
  target?: ActualDomSnapshot;
  content?: ContentScan;
};

export type RemediationItem = {
  kind: "aria" | "alt-text" | "outcome";
  message: string;
};

export type StateDiffRow = {
  attribute: string;
  intended: string;
  actual: string;
  match: boolean;
};

export type EvaluationPhase = "load" | "after-trigger";

export type AnnotationEvaluation = {
  annotations: DeveloperAnnotations;
  actual: ActualDomState;
  diff: StateDiffRow[];
  phase: EvaluationPhase;
};

export type ReportTest = {
  id: string;
  title: string;
  file: string;
  project: string;
  status: string;
  durationMs: number;
  annotations: DeveloperAnnotations;
  actualState?: ActualDomState;
  stateDiff: StateDiffRow[];
  error?: string;
  output?: string;
  remediationItems: RemediationItem[];
};

export type ReportModel = {
  runStatus: string;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  interrupted: number;
  tests: ReportTest[];
};

const ANNOTATION_FIELDS: Array<{
  label: string;
  key: keyof DeveloperAnnotations;
}> = [
  { label: "Component Name", key: "componentName" },
  { label: "Selector", key: "selector" },
  { label: "Trigger Event", key: "triggerEvent" },
  { label: "Intended State", key: "intendedState" },
  { label: "Expected Speech", key: "expectedSpeech" },
];

const annotationCache = new Map<string, DeveloperAnnotations>();

export function parseDeveloperAnnotations(
  source: string,
): DeveloperAnnotations {
  const annotations: DeveloperAnnotations = {};
  for (const field of ANNOTATION_FIELDS) {
    const match = source.match(
      new RegExp(`^\\s*\\*?\\s*${field.label}:\\s*(.+?)\\s*$`, "im"),
    );
    if (match?.[1]) {
      annotations[field.key] = match[1].trim();
    }
  }
  return annotations;
}

export function parseTriggerSelector(
  triggerEvent: string | undefined,
): string | undefined {
  if (!triggerEvent) {
    return undefined;
  }
  const explicit = triggerEvent.match(
    /(?:on\s+)?((?:[a-z][\w-]*)?(?:[#.][\w-]+)+|#[\w-]+|\[[^\]]+\])/i,
  );
  return explicit?.[1];
}

export function parseIntendedState(
  intended: string | undefined,
): IntendedAttribute[] {
  if (!intended) {
    return [];
  }
  const attrs: IntendedAttribute[] = [];
  const pattern = /([A-Za-z0-9_-]+)(?:\s*=\s*"([^"]*)")?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(intended))) {
    attrs.push({
      name: match[1],
      expected: match[2] ?? null,
    });
  }
  return attrs;
}

const WIDGET_STATE_ATTRIBUTES = new Set([
  "aria-expanded",
  "aria-controls",
  "aria-pressed",
  "aria-haspopup",
  "aria-selected",
  "aria-checked",
]);

export function isWidgetStateAttribute(name: string): boolean {
  return WIDGET_STATE_ATTRIBUTES.has(name);
}

export function isInteractiveSelector(selector: string | undefined): boolean {
  if (!selector) {
    return false;
  }
  return /^(button|summary|a|input)\b|\[role\s*=\s*['"]?(button|tab|menuitem|switch|checkbox|radio)/i.test(
    selector,
  );
}

function isActivatedStateValue(expected: string | null): boolean {
  return expected === "true" || expected === "false";
}

function lookupFromSnapshot(
  snapshot: ActualDomSnapshot | undefined,
  name: string,
): string | null | undefined {
  if (!snapshot?.found) {
    return undefined;
  }
  if (!(name in snapshot.attributes)) {
    return undefined;
  }
  return snapshot.attributes[name];
}

function lookupActual(
  name: string,
  actual: ActualDomState | undefined,
): string | null {
  const triggerValue = lookupFromSnapshot(actual?.trigger, name);
  const targetValue = lookupFromSnapshot(actual?.target, name);
  const targetIsInteractive = isInteractiveSelector(actual?.target?.selector);

  if (isWidgetStateAttribute(name)) {
    if (triggerValue !== undefined) {
      return triggerValue;
    }
    if (targetIsInteractive && targetValue !== undefined) {
      return targetValue;
    }
    if (actual?.trigger?.found || (actual?.target?.found && targetIsInteractive)) {
      return null;
    }
    return null;
  }

  if (triggerValue !== undefined && triggerValue !== null) {
    return triggerValue;
  }
  if (targetValue !== undefined && targetValue !== null) {
    return targetValue;
  }
  return triggerValue ?? targetValue ?? null;
}

export function formatStateValue(value: string | null | undefined): string {
  if (value === undefined || value === null || value === "") {
    return "(absent)";
  }
  return value;
}

export function diffIntendedAndActual(
  annotations: DeveloperAnnotations,
  actual: ActualDomState | undefined,
  phase: EvaluationPhase = "after-trigger",
): StateDiffRow[] {
  if (!actual?.trigger?.found && !actual?.target?.found) {
    return [];
  }
  return parseIntendedState(annotations.intendedState).flatMap((attr) => {
    if (
      phase === "load" &&
      isWidgetStateAttribute(attr.name) &&
      isActivatedStateValue(attr.expected)
    ) {
      return [];
    }
    const actualValue = lookupActual(attr.name, actual);
    const intended = attr.expected === null ? "(present)" : attr.expected;
    const match =
      attr.expected === null
        ? actualValue !== null && actualValue !== ""
        : actualValue === attr.expected;
    return [
      {
        attribute: attr.name,
        intended,
        actual: formatStateValue(actualValue),
        match,
      },
    ];
  });
}

export function actualFromError(error?: string): ActualDomState | undefined {
  if (!error) {
    return undefined;
  }
  const attr =
    error.match(/attribute ['"]([^'"]+)['"]/i)?.[1] ??
    error.match(/\b(aria-[\w-]+)\b/)?.[1];
  if (!attr) {
    return undefined;
  }
  const received = error.match(/Received:\s*([^\n]+)/i)?.[1]?.trim();
  const actual =
    !received || received === "null" || received === "undefined"
      ? null
      : received.replace(/^["']|["']$/g, "");
  return {
    trigger: { found: true, attributes: { [attr]: actual } },
  };
}

const REDUNDANT_ALT = /^(image of|picture of|photo of|graphic of)\b/i;

export function scanRedundantAltText(
  content: ContentScan | undefined,
  extraText = "",
): string[] {
  const alts = [...(content?.images.map((image) => image.alt) ?? [])];
  for (const match of extraText.matchAll(/\balt\s*=\s*"([^"]+)"/gi)) {
    alts.push(match[1]);
  }
  const phrases =
    extraText.match(/\b(?:image of|picture of|photo of|graphic of)\s+[^.\n]+/gi) ??
    [];
  alts.push(...phrases);
  return [...new Set(alts.map((alt) => alt.trim()).filter(Boolean))].filter((alt) =>
    REDUNDANT_ALT.test(alt),
  );
}

export function generateRemediation(
  status: string,
  diff: StateDiffRow[] = [],
  actual?: ActualDomState,
  extraText = "",
): RemediationItem[] {
  const items: RemediationItem[] = [];
  const mismatches = diff.filter((row) => !row.match);
  const control = actual?.trigger?.selector ?? "the interactive trigger";

  for (const row of mismatches) {
    if (row.attribute === "aria-expanded") {
      items.push({
        kind: "aria",
        message: `Missing aria-expanded on ${control} (intended ${row.intended}, actual ${row.actual}). Set aria-expanded="true" when the section is open and "false" when it is closed so assistive technologies hear the expanded/collapsed state.`,
      });
    } else if (row.attribute === "aria-controls") {
      items.push({
        kind: "aria",
        message: `Missing aria-controls on ${control} (intended ${row.intended}, actual ${row.actual}). Point aria-controls at the panel id so the header is programmatically tied to its content.`,
      });
    } else {
      items.push({
        kind: "aria",
        message: `Missing ${row.attribute} on ${control}: intended ${row.intended}, actual ${row.actual}. Add this state after the trigger so the DOM matches the intended accessible name/role/state.`,
      });
    }
  }

  const corpus = [
    extraText,
    ...(actual?.content?.images.map((image) => image.alt) ?? []),
  ]
    .filter(Boolean)
    .join("\n");

  for (const alt of scanRedundantAltText(actual?.content, corpus)) {
    items.push({
      kind: "alt-text",
      message: `Redundant alt text "${alt}" starts with a phrase like "image of" or "picture of". Screen readers already announce the image role, so describe the subject only (for example, "Golden retriever running on a beach").`,
    });
  }

  if (status === "failed" || status === "timedOut") {
    items.push({
      kind: "outcome",
      message:
        "The test failed. Use the intended-vs-actual table to patch the live DOM, then re-run until the captured attributes match the intended state.",
    });
  }

  if (!items.length) {
    items.push({
      kind: "outcome",
      message: "No automated remediation items. Captured checks did not find missing ARIA or redundant alt text.",
    });
  }

  return items;
}

export function shouldOpenReport(
  open: ReporterOptions["open"],
  status: FullResult["status"],
  ci = Boolean(process.env.CI),
): boolean {
  if (open === "never") {
    return false;
  }
  if (open === "on-failure") {
    return status === "failed" || status === "timedout";
  }
  if (open === "always") {
    return true;
  }
  return !ci;
}

export function openInBrowser(filePath: string): void {
  const absolute = resolve(filePath);
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", absolute], {
          detached: true,
          stdio: "ignore",
        })
      : process.platform === "darwin"
        ? spawn("open", [absolute], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [absolute], { detached: true, stdio: "ignore" });
  child.unref();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

const ANSI_ESCAPE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(/\u001B\[[0-9;]*m/g, "");
}

function plainLogText(value: string | undefined): string {
  return stripAnsi(value ?? "").trim();
}

export function toMarkdown(model: ReportModel): string {
  const lines = [
    "# Accessible test report",
    "",
    `- **Run status:** ${model.runStatus}`,
    `- **Duration:** ${formatDuration(model.durationMs)}`,
    `- **Passed:** ${model.passed}`,
    `- **Failed:** ${model.failed}`,
    `- **Skipped:** ${model.skipped}`,
    "",
  ];

  for (const test of model.tests) {
    lines.push(`## ${test.title}`, "");
    lines.push(`- **Status:** ${test.status}`);
    lines.push(`- **Duration:** ${formatDuration(test.durationMs)}`);
    lines.push(`- **Project:** ${test.project || "(default)"}`);
    lines.push(`- **File:** ${test.file}`);
    lines.push("", "### Developer annotations", "");
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    for (const field of ANNOTATION_FIELDS) {
      lines.push(`| ${field.label} | ${test.annotations[field.key] || "—"} |`);
    }
    lines.push("", "### Automated remediation", "");
    if (test.stateDiff.length) {
      lines.push("#### Intended vs actual DOM state", "");
      lines.push("| Attribute | Intended | Actual | Match |");
      lines.push("| --- | --- | --- | --- |");
      for (const row of test.stateDiff) {
        lines.push(
          `| ${row.attribute} | ${row.intended} | ${row.actual} | ${row.match ? "Yes" : "No"} |`,
        );
      }
      lines.push("");
    }
    for (const item of test.remediationItems) {
      lines.push(`- ${item.message}`);
    }
    lines.push("");
    const error = plainLogText(test.error);
    if (error) {
      lines.push("### Error / diff", "", "```", error, "```", "");
    }
    const output = plainLogText(test.output);
    if (output) {
      lines.push("### Output", "", "```", output, "```", "");
    }
  }

  return lines.join("\n").trim() + "\n";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function disclosure(
  id: string,
  label: string,
  innerHtml: string,
): string {
  const buttonId = `${id}-btn`;
  const panelId = `${id}-panel`;
  return `
    <button
      type="button"
      class="disclosure"
      id="${buttonId}"
      data-disclosure
      data-section-label="${escapeHtml(label)}"
      aria-expanded="false"
      aria-controls="${panelId}"
    >
      ${escapeHtml(label)}
    </button>
    <div
      id="${panelId}"
      class="disclosure-panel"
      role="region"
      aria-labelledby="${buttonId}"
      aria-live="polite"
      hidden
    >
      ${innerHtml}
    </div>`;
}

function annotationList(annotations: DeveloperAnnotations): string {
  const items = ANNOTATION_FIELDS.map((field) => {
    const value = annotations[field.key] || "—";
    return `<dt>${escapeHtml(field.label)}</dt>
      <dd>${escapeHtml(value)}</dd>`;
  }).join("");
  return `<dl class="annotations">${items}</dl>`;
}

function comparisonTable(diff: StateDiffRow[]): string {
  if (!diff.length) {
    return "";
  }
  const rows = diff
    .map(
      (row) => `<tr class="${row.match ? "match" : "mismatch"}">
        <th scope="row">${escapeHtml(row.attribute)}</th>
        <td>${escapeHtml(row.intended)}</td>
        <td>${escapeHtml(row.actual)}</td>
        <td>${row.match ? "Yes" : "No"}</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="compare">
      <caption>Intended vs actual DOM state</caption>
      <thead>
        <tr>
          <th scope="col">Attribute</th>
          <th scope="col">Intended</th>
          <th scope="col">Actual</th>
          <th scope="col">Match</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function toHtml(model: ReportModel): string {
  const markdown = toMarkdown(model);
  const tests = model.tests
    .map((test, index) => {
      const remediationList = `<ul class="remediation-list">${test.remediationItems
        .map((item) => `<li data-kind="${escapeHtml(item.kind)}">${escapeHtml(item.message)}</li>`)
        .join("")}</ul>`;
      const error = plainLogText(test.error);
      const output = plainLogText(test.output);
      const logs =
        error || output
          ? `<div class="card-logs" data-testid="test-logs-${index}">
              ${
                error
                  ? disclosure(
                      `error-${index}`,
                      "Error / diff",
                      `<pre><code>${escapeHtml(error)}</code></pre>`,
                    )
                  : ""
              }
              ${
                output
                  ? disclosure(
                      `output-${index}`,
                      "Output",
                      `<pre><code>${escapeHtml(output)}</code></pre>`,
                    )
                  : ""
              }
            </div>`
          : "";
      return `
        <article
          class="card status-${escapeHtml(test.status)}"
          aria-labelledby="test-${index}-title"
          tabindex="0"
          data-testid="test-card-${index}"
        >
          <header class="card-head">
            <h3 id="test-${index}-title">${escapeHtml(test.title)}</h3>
            <p class="meta">
              <span class="badge">${escapeHtml(test.status)}</span>
              <span>Duration ${escapeHtml(formatDuration(test.durationMs))}</span>
              <span>${escapeHtml(test.project || "default")}</span>
            </p>
            <p class="file">${escapeHtml(test.file)}</p>
          </header>
          <div class="split">
            <section class="anno-pane" aria-labelledby="anno-${index}-heading">
              <h4 id="anno-${index}-heading">Developer annotations</h4>
              ${annotationList(test.annotations)}
            </section>
            <section class="remediation-pane" aria-labelledby="remediation-${index}-heading">
              <h4 id="remediation-${index}-heading">Automated remediation</h4>
              ${comparisonTable(test.stateDiff)}
              ${remediationList}
            </section>
          </div>
          ${logs}
        </article>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Accessible test report</title>
  <style>
    :root {
      --text: #1b1b1f;
      --muted: #4a4a55;
      --bg: #ffffff;
      --surface: #f3f4f7;
      --border: #6b6b78;
      --accent: #1a4fa0;
      --accent-text: #ffffff;
      --error: #a4001d;
      --success: #1e6b2f;
      --focus: #b3470b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: var(--bg);
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    .skip {
      position: absolute;
      left: -999px;
    }
    .skip:focus {
      left: 1rem;
      top: 1rem;
      background: var(--bg);
      padding: 0.5rem 0.75rem;
      z-index: 2;
    }
    .status-live {
      min-height: 1.5em;
      margin: 0.5rem 0 0;
      color: var(--muted);
      font-weight: 600;
    }
    header.page, main {
      max-width: 72rem;
      margin: 0 auto;
      padding: 1.25rem 1rem;
    }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      align-items: start;
    }
    @media (max-width: 50rem) {
      .split { grid-template-columns: 1fr; }
    }
    .result-pane, .anno-pane, .remediation-pane {
      padding: 0.75rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .remediation-list {
      margin: 0.75rem 0 0;
      padding-left: 1.2rem;
    }
    .remediation-list li {
      margin: 0.4rem 0;
    }
    .compare {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0.5rem;
    }
    .compare caption {
      text-align: left;
      font-weight: 600;
      padding-bottom: 0.35rem;
    }
    .compare th, .compare td {
      border: 1px solid var(--border);
      padding: 0.35rem 0.5rem;
      text-align: left;
    }
    .compare .mismatch {
      background: #fdecee;
      color: var(--error);
    }
    .view-bar {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--bg);
      padding: 0.75rem 0 1rem;
      border-bottom: 1px solid var(--border);
    }
    .view-bar p {
      margin: 0 0 0.5rem;
      color: var(--muted);
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin: 1rem 0;
    }
    .summary span {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.35rem 0.7rem;
    }
    .view-toggle {
      display: inline-flex;
      border: 2px solid var(--accent);
      border-radius: 4px;
    }
    .view-toggle [role="tab"] {
      margin: 0;
      padding: 0.55rem 1rem;
      font: inherit;
      font-weight: 600;
      color: var(--accent);
      background: var(--bg);
      border: 0;
      cursor: pointer;
    }
    .view-toggle [role="tab"] + [role="tab"] {
      border-left: 2px solid var(--accent);
    }
    .view-toggle [role="tab"][aria-selected="true"] {
      color: var(--accent-text);
      background: var(--accent);
    }
    .card-logs {
      margin-top: 1rem;
    }
    .card {
      margin: 1rem 0;
      padding: 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .card.status-failed, .card.status-timedOut {
      border-left: 4px solid var(--error);
    }
    .card.status-passed {
      border-left: 4px solid var(--success);
    }
    .meta, .file, h4 { color: var(--muted); }
    .badge {
      display: inline-block;
      padding: 0.1rem 0.45rem;
      border-radius: 4px;
      color: var(--accent-text);
      background: var(--accent);
      text-transform: capitalize;
    }
    .status-failed .badge, .status-timedOut .badge { background: var(--error); }
    .status-passed .badge { background: var(--success); }
    .annotations {
      margin: 0;
      display: grid;
      grid-template-columns: 11rem 1fr;
      gap: 0.35rem 0.75rem;
    }
    dt { font-weight: 600; }
    dd { margin: 0; }
    .disclosure {
      display: block;
      width: 100%;
      margin-top: 0.75rem;
      padding: 0.5rem 0.75rem;
      font: inherit;
      font-weight: 600;
      text-align: left;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
    }
    .disclosure-panel {
      margin: 0;
      padding: 0.75rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: 0;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to report</a>
  <header class="page">
    <h1>Accessible test report</h1>
    <p>
      Run status <strong>${escapeHtml(model.runStatus)}</strong>
      in ${escapeHtml(formatDuration(model.durationMs))}.
    </p>
    <p class="summary">
      <span>Passed ${model.passed}</span>
      <span>Failed ${model.failed}</span>
      <span>Skipped ${model.skipped}</span>
    </p>
    <div class="view-bar">
      <p>Switch between the standard graphical report and the accessible Markdown source.</p>
      <div class="view-toggle" role="tablist" aria-label="Report view" data-testid="view-toggle">
        <button
          type="button"
          role="tab"
          id="view-graphical"
          aria-selected="true"
          aria-controls="graphical-view"
          tabindex="0"
          data-testid="view-graphical"
        >Standard graphical view</button>
        <button
          type="button"
          role="tab"
          id="view-markdown"
          aria-selected="false"
          aria-controls="markdown-view"
          tabindex="-1"
          data-testid="view-markdown"
        >Accessible Markdown source view</button>
      </div>
      <p
        id="view-live"
        class="status-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="view-live"
      >Standard graphical view selected</p>
      <p
        id="section-live"
        class="status-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="section-live"
      >No section expanded</p>
    </div>
  </header>
  <main id="main">
    <section
      id="graphical-view"
      role="tabpanel"
      data-testid="graphical-view"
      aria-labelledby="view-graphical"
    >
      <h2 id="results-heading">Test results</h2>
      ${tests || "<p>No tests ran.</p>"}
    </section>
    <section
      id="markdown-view"
      role="tabpanel"
      data-testid="markdown-view"
      aria-labelledby="view-markdown"
      hidden
    >
      <h2 id="markdown-heading">Markdown source view</h2>
      <pre id="markdown-source"><code>${escapeHtml(markdown)}</code></pre>
    </section>
  </main>
  <script>
    (function () {
      var graphicalView = document.getElementById("graphical-view");
      var markdownView = document.getElementById("markdown-view");
      var graphicalBtn = document.getElementById("view-graphical");
      var markdownBtn = document.getElementById("view-markdown");
      var viewLive = document.getElementById("view-live");
      var sectionLive = document.getElementById("section-live");
      var tabs = [graphicalBtn, markdownBtn];

      function setView(mode, moveFocus) {
        var isGraphical = mode === "graphical";
        graphicalView.hidden = !isGraphical;
        markdownView.hidden = isGraphical;
        graphicalBtn.setAttribute("aria-selected", isGraphical ? "true" : "false");
        markdownBtn.setAttribute("aria-selected", isGraphical ? "false" : "true");
        graphicalBtn.tabIndex = isGraphical ? 0 : -1;
        markdownBtn.tabIndex = isGraphical ? -1 : 0;
        viewLive.textContent = isGraphical
          ? "Standard graphical view selected"
          : "Accessible Markdown source view selected";
        if (moveFocus) {
          (isGraphical ? graphicalBtn : markdownBtn).focus();
        }
      }

      graphicalBtn.addEventListener("click", function () { setView("graphical"); });
      markdownBtn.addEventListener("click", function () { setView("markdown"); });

      function onTabListKeydown(event) {
        var index = tabs.indexOf(event.currentTarget);
        var next = index;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          next = (index + 1) % tabs.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          next = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === "Home") {
          next = 0;
        } else if (event.key === "End") {
          next = tabs.length - 1;
        } else {
          return;
        }
        event.preventDefault();
        setView(next === 0 ? "graphical" : "markdown", true);
      }

      tabs.forEach(function (tab) {
        tab.addEventListener("keydown", onTabListKeydown);
      });

      function toggleDisclosure(button) {
        var expanded = button.getAttribute("aria-expanded") === "true";
        var next = !expanded;
        var panel = document.getElementById(button.getAttribute("aria-controls"));
        button.setAttribute("aria-expanded", next ? "true" : "false");
        if (panel) {
          panel.hidden = !next;
        }
        var label = button.getAttribute("data-section-label") || "Section";
        sectionLive.textContent = label + (next ? " expanded" : " collapsed");
      }

      document.querySelectorAll("[data-disclosure]").forEach(function (button) {
        button.addEventListener("click", function () { toggleDisclosure(button); });
      });
    })();
  </script>
</body>
</html>
`;
}

function annotationsFromTest(test: TestCase): DeveloperAnnotations {
  const fromFile = annotationsFromFile(test.location.file);
  const merged: DeveloperAnnotations = { ...fromFile };
  for (const annotation of test.annotations) {
    const field = ANNOTATION_FIELDS.find(
      (item) => item.label.toLowerCase() === annotation.type.toLowerCase(),
    );
    if (field && annotation.description) {
      merged[field.key] = annotation.description;
    }
  }
  return merged;
}

function annotationsFromFile(file: string): DeveloperAnnotations {
  const cached = annotationCache.get(file);
  if (cached) {
    return cached;
  }
  try {
    const source = readFileSync(file, "utf8");
    const parsed = parseDeveloperAnnotations(source);
    annotationCache.set(file, parsed);
    return parsed;
  } catch {
    const empty = {};
    annotationCache.set(file, empty);
    return empty;
  }
}

function stdioToText(chunks: TestResult["stdout"] | undefined): string {
  if (!chunks?.length) {
    return "";
  }
  return plainLogText(
    chunks
      .map((chunk) => (typeof chunk === "string" ? chunk : chunk.toString("utf8")))
      .join(""),
  );
}

function readAnnotationEval(
  result: TestResult | undefined,
): AnnotationEvaluation | undefined {
  const attachment = result?.attachments.find(
    (item) =>
      item.name === ANNOTATION_EVAL_ATTACHMENT ||
      item.name.endsWith("annotation-eval.json"),
  );
  if (!attachment) {
    return undefined;
  }
  try {
    const raw = attachment.body
      ? attachment.body.toString("utf8")
      : attachment.path
        ? readFileSync(attachment.path, "utf8")
        : "";
    return raw ? (JSON.parse(raw) as AnnotationEvaluation) : undefined;
  } catch {
    return undefined;
  }
}

export function serializeTest(
  test: TestCase,
  cwd = process.cwd(),
): ReportTest {
  const result = test.results.at(-1);
  const status = result?.status ?? test.expectedStatus;
  const annotations = annotationsFromTest(test);
  const error = plainLogText(
    [result?.error?.message, result?.error?.stack, result?.error?.snippet]
      .filter(Boolean)
      .join("\n"),
  );
  const output =
    stdioToText(result?.stdout) || stdioToText(result?.stderr) || "";
  const evaluation = readAnnotationEval(result);
  const actualState = evaluation?.actual ?? actualFromError(error);
  const phase = evaluation?.phase ?? (error ? "after-trigger" : "load");
  const stateDiff = evaluation
    ? evaluation.diff
    : actualState
      ? diffIntendedAndActual(annotations, actualState, phase)
      : [];
  return {
    id: test.id,
    title: test.title,
    file: relative(cwd, test.location.file).replaceAll("\\", "/"),
    project: test.parent.project()?.name ?? "",
    status,
    durationMs: result?.duration ?? 0,
    annotations,
    actualState,
    stateDiff,
    error: error || undefined,
    output: output || undefined,
    remediationItems: generateRemediation(
      status,
      stateDiff,
      actualState,
      [error, output].filter(Boolean).join("\n"),
    ),
  };
}

export function buildReportModel(
  suite: Suite,
  result: FullResult,
  cwd = process.cwd(),
): ReportModel {
  const tests = suite.allTests().map((test) => serializeTest(test, cwd));
  return {
    runStatus: result.status,
    durationMs: result.duration,
    passed: tests.filter((test) => test.status === "passed").length,
    failed: tests.filter(
      (test) => test.status === "failed" || test.status === "timedOut",
    ).length,
    skipped: tests.filter((test) => test.status === "skipped").length,
    interrupted: tests.filter((test) => test.status === "interrupted").length,
    tests,
  };
}

export default class AccessibleMarkdownReporter implements Reporter {
  private outputFile: string;
  private open: ReporterOptions["open"];
  private suite: Suite | undefined;
  private config: FullConfig | undefined;
  private runStatus: FullResult["status"] = "passed";

  constructor(options: ReporterOptions = {}) {
    this.outputFile = resolve(
      process.cwd(),
      options.outputFile ?? "accessible-report/index.html",
    );
    this.open = options.open;
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
  }

  onEnd(result: FullResult): void {
    if (!this.suite) {
      return;
    }
    this.runStatus = result.status;
    const cwd = process.cwd();
    const model = buildReportModel(this.suite, result, cwd);
    const html = toHtml(model);
    const markdown = toMarkdown(model);
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, html, "utf8");
    writeFileSync(this.outputFile.replace(/\.html?$/i, ".md"), markdown, "utf8");
    console.log(`Accessible report: ${this.outputFile}`);
  }

  async onExit(): Promise<void> {
    if (shouldOpenReport(this.open, this.runStatus)) {
      openInBrowser(this.outputFile);
    }
  }
}
