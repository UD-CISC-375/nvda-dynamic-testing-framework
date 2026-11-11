import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Results include HTML snippets and test-controlled text; escape all values before inserting them into report markup.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function display(value, fallback = "Not included in results.json") {
  return value == null || value === "" ? fallback : String(value);
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function docsLink(url) {
  // Only link to HTTPS documentation URLs supplied by the axe result.
  if (!isHttpsUrl(url)) return "";
  return ` <a href="${escapeHtml(url)}">Read the axe rule documentation</a>`;
}

function isHttpsUrl(url) {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function itemCount(node) {
  const descendants = [];
  const visit = (current) => {
    for (const child of current.children ?? []) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(node);

  // Count recognized accessible item roles rather than every nested wrapper.
  const itemNodes = descendants.filter((child) =>
    ["menuitem", "menuitemcheckbox", "menuitemradio", "listitem", "option"].includes(
      child.properties?.role,
    ),
  );
  return itemNodes.length || (node.children ?? []).length;
}

function describeNode(action, node) {
  const role = node.properties?.role;
  const name = node.properties?.name;
  const label = [
    typeof role === "string" ? role : "content",
    typeof name === "string" && name ? ` '${name}'` : "",
  ].join("");
  const count = itemCount(node);
  const children = count ? ` with ${plural(count, "item")}` : "";
  return `${action}: ${label}${children}`;
}

function describeTreeDiff(state) {
  const diff = state.treeDiff ?? {};
  const changes = [];

  for (const change of diff.added ?? []) {
    changes.push(describeNode("Added", change.subtree));
  }
  for (const change of diff.removed ?? []) {
    changes.push(describeNode("Removed", change.subtree));
  }
  for (const change of diff.changed ?? []) {
    for (const property of change.properties ?? []) {
      const role = change.role || "element";
      const name = change.name ? ` '${change.name}'` : "";
      const before = display(property.before, "unset");
      const after = display(property.after, "unset");
      changes.push(
        `Changed: ${role}${name}, ${property.name} ${before} to ${after}`,
      );
    }
  }
  for (const change of diff.reordered ?? []) {
    changes.push("Changed: the order of items");
  }
  return changes;
}

// Presents all of the details a reader needs without requiring knowledge of axe's JSON format.
function violationCard(violation, label) {
  const target = Array.isArray(violation.target)
    ? violation.target.map((part) => JSON.stringify(part)).join(" ")
    : display(violation.target);
  const heading = `${display(violation.rule, "Unknown rule")}: ${display(violation.help, "axe finding")}`;

  return `<article class="finding">
    <h4>${escapeHtml(heading)}</h4>
    <p class="finding-meta">${escapeHtml(label)}${violation.impact ? ` · ${escapeHtml(violation.impact)} impact` : ""}${docsLink(violation.helpUrl)}</p>
    <p><strong>Failure summary</strong></p>
    <pre>${escapeHtml(display(violation.failureSummary))}</pre>
    <p><strong>Element HTML</strong></p>
    <pre><code>${escapeHtml(display(violation.html))}</code></pre>
    <p><strong>Target</strong>: <code>${escapeHtml(target)}</code></p>
  </article>`;
}

function findingSection(title, violations, baseline = false) {
  const heading = baseline ? "Found at baseline" : title;
  const content = violations.length
    ? violations.map((violation) => violationCard(violation, heading)).join("\n")
    : `<p class="empty">None recorded.</p>`;
  return `<div class="finding-group">
    <h4>${escapeHtml(heading)} <span class="count">(${violations.length})</span></h4>
    ${content}
  </div>`;
}

function verdictFor(scenario) {
  const states = scenario.states ?? [];
  // State zero is the baseline; only later states can introduce new violations.
  const transitions = states.slice(1);
  const newCount = transitions.reduce(
    (total, state) => total + (state.axe?.new?.length ?? 0),
    0,
  );
  const finalCount = states.at(-1)?.axe?.totalCount ?? 0;

  if (transitions.length === 0) {
    return finalCount
      ? `${plural(finalCount, "axe violation")} present in the only recorded state.`
      : "No axe violations in the only recorded state.";
  }

  const transitionText =
    transitions.length === 1
      ? ` after this action: ${display(transitions[0].trigger, "State change")}`
      : ` across ${transitions.length} state changes`;
  const newText = newCount
    ? `${plural(newCount, "new axe violation")}${transitionText}`
    : `No new axe violations${transitionText}`;
  const remainingText = finalCount
    ? `${plural(finalCount, "axe violation")} ${finalCount === 1 ? "remains" : "remain"} at the end.`
    : "No axe violations remain at the end.";
  return `${newText}; ${remainingText}`;
}

function renderState(state, index, scenarioIndex) {
  // Prefer specific authored phrasing, and fall back to a plain-language tree diff.
  const treeChanges =
    state.assistiveTechChanges?.length > 0
      ? state.assistiveTechChanges
      : describeTreeDiff(state);
  const baseline = index === 0;
  const changeList = treeChanges.length
    ? `<ul>${treeChanges.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>`
    : `<p class="empty">No accessibility-tree change recorded.</p>`;
  const resolved = state.axe?.resolved ?? [];
  const fresh = state.axe?.new ?? [];

  return `<div class="state">
    <h3 id="state-${scenarioIndex}-${index}-heading">State ${escapeHtml(state.index ?? index)}</h3>
    <p class="trigger"><strong>Trigger:</strong> ${escapeHtml(display(state.trigger))}</p>
    <div class="change-summary">
      <h4>What assistive technology can detect</h4>
      ${changeList}
    </div>
    <p class="stability">${state.stable === true ? "State stabilized" : state.stable === false ? "State did not stabilize" : "Stability not recorded"}</p>
    ${findingSection("New violations", fresh, baseline)}
    ${findingSection("Resolved violations", resolved)}
    <p class="total-count">Axe violations in this state: ${escapeHtml(state.axe?.totalCount ?? 0)}</p>
  </div>`;
}

function validateResults(results, inputPath) {
  if (
    !results ||
    results.schemaVersion !== 0 ||
    !results.run ||
    !Array.isArray(results.run.scenarios)
  ) {
    throw new Error(
      `${inputPath} must contain schemaVersion: 0 and run.scenarios`,
    );
  }

  // Fail early rather than emitting a report that silently omits required scenario or finding details.
  for (const [index, scenario] of results.run.scenarios.entries()) {
    if (
      !scenario ||
      typeof scenario !== "object" ||
      typeof scenario.scenario !== "string" ||
      typeof scenario.variant !== "string" ||
      !Array.isArray(scenario.states)
    ) {
      throw new Error(
        `${inputPath}: scenario ${index} must have scenario, variant, and states`,
      );
    }
    if (!["passed", "failed", "skipped"].includes(scenario.verdict)) {
      throw new Error(
        `${inputPath}: scenario ${index} has an invalid verdict`,
      );
    }
    if (scenario.states.length === 0 && scenario.verdict !== "skipped") {
      throw new Error(`${inputPath}: scenario ${index} has no recorded states`);
    }
    if (scenario.verdict === "skipped" && !scenario.skippedReason?.trim()) {
      throw new Error(`${inputPath}: scenario ${index} has no skipped reason`);
    }

    for (const [stateIndex, state] of scenario.states.entries()) {
      if (
        !state ||
        typeof state !== "object" ||
        typeof state.trigger !== "string" ||
        !state.trigger.trim() ||
        !state.axe ||
        !Array.isArray(state.axe.new) ||
        !Array.isArray(state.axe.resolved) ||
        !Number.isInteger(state.axe.totalCount) ||
        state.axe.totalCount < 0
      ) {
        throw new Error(
          `${inputPath}: scenario ${index}, state ${stateIndex} has no trigger or incomplete axe data`,
        );
      }

      for (const violation of [...state.axe.new, ...state.axe.resolved]) {
        if (
          typeof violation.rule !== "string" || !violation.rule.trim() ||
          !Array.isArray(violation.target) ||
          violation.target.length === 0 ||
          typeof violation.help !== "string" || !violation.help.trim() ||
          typeof violation.failureSummary !== "string" || !violation.failureSummary.trim() ||
          typeof violation.html !== "string" || !violation.html.trim() ||
          !isHttpsUrl(violation.helpUrl)
        ) {
          throw new Error(
            `${inputPath}: scenario ${index}, state ${stateIndex} has an axe finding missing rule, target, help, HTTPS helpUrl, failureSummary, or html`,
          );
        }
      }
    }
  }
}

function renderScenario(scenario, scenarioIndex) {
  const warning = scenario.nvdaOnly
    ? `<div class="nvda-warning">
        <h3>Axe cannot detect this flaw</h3>
        <p>This scenario includes an NVDA-only check. A clean axe result does not mean this behavior is accessible; review the assistive-technology changes and test assertions.</p>
      </div>`
    : "";
  const states = scenario.states
    .map((state, index) => renderState(state, index, scenarioIndex))
    .join("\n") || '<p>No states were recorded for this scenario.</p>';
  const status =
    scenario.verdict === "skipped"
      ? `Skipped: ${display(scenario.skippedReason)}`
      : `${scenario.verdict === "failed" ? "Accessibility failure detected." : "Recorded checks passed."} ${verdictFor(scenario)}${scenario.nvdaOnly ? " Axe cannot assess NVDA-only behavior." : ""}`;

  return `<article class="scenario" aria-labelledby="scenario-${scenarioIndex}-heading">
    <h2 id="scenario-${scenarioIndex}-heading">${escapeHtml(scenario.scenario)} — ${escapeHtml(scenario.variant)}</h2>
    <p class="verdict ${escapeHtml(scenario.verdict)}">${escapeHtml(status)}</p>
    ${scenario.executionNote ? `<p><strong>Test execution:</strong> ${escapeHtml(scenario.executionNote)}</p>` : ""}
    ${warning}
    <div class="timeline">${states}</div>
  </article>`;
}

function renderReport(results, rawJson) {
  const scenarios = results.run.scenarios
    .map(renderScenario)
    .join("\n");
  const timestamp = display(results.run.timestamp);
  const commit = display(results.run.commit);
  const siteUrl =
    isHttpsUrl(results.run.siteUrl)
      ? `<a href="${escapeHtml(results.run.siteUrl)}">${escapeHtml(results.run.siteUrl)}</a>`
      : escapeHtml(display(results.run.siteUrl));
  const scope = results.run.scope
    ? `<p><strong>Report scope:</strong> ${escapeHtml(results.run.scope)}</p>`
    : "";

  // Inline styles and native disclosure keep the generated page standalone and usable without JavaScript.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Accessibility test results</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17212b; background: #f5f7fa; }
    * { box-sizing: border-box; }
    body { margin: 0; line-height: 1.55; }
    a { color: #0645ad; text-decoration-thickness: .08em; text-underline-offset: .15em; }
    a:hover { text-decoration-thickness: .15em; }
    a:focus-visible, summary:focus-visible { outline: 3px solid #a34a00; outline-offset: 3px; }
    header, main, footer { width: min(100% - 2rem, 72rem); margin-inline: auto; }
    header { padding-block: 2rem 1rem; }
    h1 { margin: 0; font-size: clamp(1.8rem, 4vw, 2.5rem); line-height: 1.15; }
    .run-meta { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; color: #374151; }
    main { padding-block: 1rem 3rem; }
    .scenario { margin-block: 1.5rem; padding: 1.25rem; border: 1px solid #9aa8b5; border-radius: .6rem; background: #fff; }
    .scenario > h2 { margin-top: 0; }
    .verdict { padding: .8rem 1rem; border-left: .35rem solid #155e36; background: #edf7f0; font-size: 1.15rem; font-weight: 700; }
    .verdict.failed { border-color: #9c1c1c; background: #fff0f0; }
    .verdict.skipped { border-color: #6a4c00; background: #fff4df; }
    .nvda-warning { margin-block: 1rem; padding: 1rem; border: 2px solid #7a3e00; border-radius: .35rem; background: #fff4df; }
    .nvda-warning h3 { margin: 0 0 .25rem; }
    .nvda-warning p { margin: 0; }
    .state { margin: 1rem 0 0 1rem; padding: 1rem; border-left: .2rem solid #63758a; }
    .state h3 { margin-top: 0; }
    .trigger { font-size: 1.05rem; }
    .change-summary, .finding-group { margin-block: 1rem; }
    .finding-group { padding-top: .75rem; border-top: 1px solid #c5cdd5; }
    .finding-group > h4 { margin: 0 0 .75rem; }
    .finding { margin-block: .75rem; padding: 1rem; border: 1px solid #aeb8c2; border-radius: .35rem; background: #fbfcfe; }
    .finding h4 { margin: 0; }
    .finding-meta { color: #374151; }
    .finding pre { overflow-wrap: anywhere; white-space: pre-wrap; padding: .75rem; border-radius: .25rem; background: #eef1f4; color: #17212b; }
    .finding code, code { overflow-wrap: anywhere; }
    .empty, .count, .stability, .total-count { color: #374151; }
    details { margin-top: 2rem; padding: 1rem; border: 1px solid #7e8b98; border-radius: .4rem; background: #fff; }
    summary { width: fit-content; cursor: pointer; font-weight: 700; }
    details pre { max-height: 40rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
    footer { padding-block: 0 2rem; color: #374151; }
    @media (max-width: 40rem) { .state { margin-left: .25rem; padding-inline: .75rem; } .scenario { padding: .9rem; } }
  </style>
</head>
<body>
  <header>
    <h1>Accessibility test results</h1>
    <div class="run-meta">
      <p><strong>Run:</strong> <time>${escapeHtml(timestamp)}</time></p>
      <p><strong>Commit:</strong> <code>${escapeHtml(commit)}</code></p>
      <p><strong>Test site:</strong> ${siteUrl}</p>
    </div>
  </header>
  <main>
    <h2>Results by scenario and variant</h2>
    ${scope}
    ${scenarios || '<p>No scenarios were recorded.</p>'}
    <details>
      <summary>Show raw results.json</summary>
      <pre tabindex="0" aria-label="Raw results JSON"><code>${escapeHtml(rawJson)}</code></pre>
    </details>
  </main>
  <footer><p>Generated from results.json. This report is a test aid, not a substitute for testing with assistive technology.</p></footer>
</body>
</html>
`;
}

const [inputArg = "results.json", outputArg = "report.html"] =
  process.argv.slice(2);
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);

try {
  // Protect the source results from accidental overwrite when callers pass the same path twice.
  if (inputPath === outputPath) {
    throw new Error("input and output paths must be different");
  }
  const rawJson = await readFile(inputPath, "utf8");
  const results = JSON.parse(rawJson);
  validateResults(results, inputPath);
  await writeFile(outputPath, renderReport(results, rawJson), "utf8");
  console.log(`Wrote offline report to ${outputPath}`);
} catch (error) {
  console.error(
    `Could not generate report: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
