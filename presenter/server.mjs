// Local server for presentations: shows index.html, and runs the Playwright
// tests when a button is clicked. Start it with `npm run present`.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Override with the PORT environment variable if 4375 is already in use.
const PORT = Number(process.env.PORT) || 4375;
// Repo root, so Playwright finds playwright.config.ts (and Team Y's baseURL).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Playwright's command-line entry point. Running it with `node` directly avoids
// npx, which on Windows is a .cmd file that spawn() can't start without a shell.
const PLAYWRIGHT_CLI = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");
// Same default as playwright.config.ts, which this plain-JS server can't import.
const BASE_URL = process.env.BASE_URL ?? "https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/";
// The "Before X2" buttons: which tests each runs. The page picks one with /run?suite=<name>.
const SUITES = {
  "aria-tree": ["menu-aria-tree.spec.ts"],
  // --grep-invert skips tests whose title matches. "menu page loads" only
  // checks the starting state, and its window opening and closing right
  // before the first test looked like a click nobody made.
  "watch-dom": ["menu.spec.ts", "--grep-invert", "menu page loads"],
};
// Like `npm run test:manual`, limited to one suite: a visible browser opens
// and the presenter clicks the menu button themselves (see clickTrigger in the
// specs). The JSON reporter prints the whole run, attachments included, as one
// JSON document on stdout, which is easier to pick the results out of than plain text.
const suiteArgs = (args) => ["test", ...args, "--project=manual", "--reporter=json"];
// A scenario run: Playwright clicks, in a visible browser. --workers=1 runs
// accessible and then broken one after the other, so the audience sees both.
const scenarioArgs = ["test", "presenter-scenario.spec.ts", "--project=chromium", "--headed", "--workers=1", "--reporter=json"];

// Only one run at a time; a second click while running is refused.
let running = false;

// Send a plain-text reply.
const text = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
};

const server = createServer(async (req, res) => {
  // Split "/run?suite=watch-dom" into its path and query. req.url has no host,
  // and URL() needs one, so any placeholder host will do.
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(new URL("index.html", import.meta.url));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/scenarios") {
    try {
      // Team Y's manifest; the page only needs enough to draw the buttons.
      const manifest = await (await fetch(new URL("scenarios.json", BASE_URL))).json();
      const list = manifest.scenarios.map(({ id, title, category }) => ({ id, title, category }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
    } catch (e) {
      text(res, 502, `Couldn't load ${BASE_URL}scenarios.json: ${e.message}\n`);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    // ?scenario=<id> runs the tracker spec; ?suite=<name> (or nothing) an old suite.
    const scenario = url.searchParams.get("scenario");
    const suite = SUITES[url.searchParams.get("suite") ?? "aria-tree"];
    if (!scenario && !suite) {
      text(res, 400, `Unknown suite. Use one of: ${Object.keys(SUITES).join(", ")}.\n`);
      return;
    }
    if (running) {
      text(res, 409, "Tests are already running.\n");
      return;
    }
    running = true;

    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, ...(scenario ? scenarioArgs : suiteArgs(suite))], {
      cwd: ROOT,
      // FORCE_COLOR=0: no terminal color codes in any error text sent to the page.
      // SLOW_MO=500: playwright.config.ts pauses 500 ms before each browser
      // action, so the audience can see what's clicked.
      // SCENARIO picks the scenario in presenter-scenario.spec.ts.
      env: { ...process.env, FORCE_COLOR: "0", SLOW_MO: "500", ...(scenario && { SCENARIO: scenario }) },
    });
    // Collect all output; the JSON is only complete once Playwright exits.
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      running = false;
      let tests;
      try {
        tests = summarize(JSON.parse(stdout));
      } catch {
        // Not JSON (e.g. Playwright couldn't start): send the raw output instead.
        text(res, 500, `Playwright exited with code ${code}.\n${stderr}${stdout}`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (scenario) {
        // One column per variant, keyed by the attachment's name.
        const results = {};
        for (const t of tests) {
          if (t.variant) results[t.variant] = { status: t.status, error: t.error, ...t.presenter };
        }
        res.end(JSON.stringify({ exitCode: code, results }));
      } else {
        res.end(JSON.stringify({ exitCode: code, tests }));
      }
    });
    return;
  }

  text(res, 404, "Not found\n");
});

// Read a JSON attachment's body, which the report stores in base64.
const decode = (attachment) => JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"));

// Turn Playwright's JSON report into
// [{ title, status, error, added, removed, changes, output, variant, presenter }], one entry
// per test, keeping only what the page shows. added/removed come from the aria-tree
// spec, changes from the watch-dom one; whichever a test didn't attach is [].
// variant/presenter come from presenter-scenario.spec.ts's "presenter-<variant>.json".
// output is everything the test printed with console.log.
function summarize(report) {
  const tests = [];
  // Suites can nest (file > describe > ...), so walk them recursively.
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        // The last result is the final attempt (earlier ones are retries).
        const result = test.results.at(-1);
        // A test that never ran (e.g. skipped) has no result.
        if (!result) continue;
        // The spec attaches its diff as "tree-<variant>-diff.json", body in base64.
        const diffAttachment = result.attachments.find((a) => /^tree-.*-diff\.json$/.test(a.name));
        const diff = diffAttachment ? decode(diffAttachment) : { added: [], removed: [] };
        // The watch-dom spec attaches its recorded changes as "dom-changes.json".
        const changesAttachment = result.attachments.find((a) => a.name === "dom-changes.json");
        // The presenter spec attaches one result file per variant.
        const presenterAttachment = result.attachments.find((a) => /^presenter-.*\.json$/.test(a.name));
        tests.push({
          title: spec.title,
          status: result.status,
          // First line of the failure message, if the test failed.
          error: result.errors[0]?.message?.split("\n")[0],
          added: diff.added,
          removed: diff.removed,
          changes: changesAttachment ? decode(changesAttachment) : [],
          variant: presenterAttachment?.name.match(/^presenter-(.*)\.json$/)[1],
          presenter: presenterAttachment ? decode(presenterAttachment) : undefined,
          // The report keeps printed output in chunks, each either plain text
          // or (rarely) base64 bytes; join them back into one string.
          output: result.stdout
            .map((chunk) => chunk.text ?? Buffer.from(chunk.buffer, "base64").toString("utf8"))
            .join("")
            // Playwright's workers color printed objects even with FORCE_COLOR=0;
            // drop the color codes (ESC [ ... m) so the page shows plain text.
            .replace(/\x1b\[[0-9;]*m/g, ""),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return tests;
}

// "127.0.0.1" so only this computer can reach the server, not others on the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Open http://localhost:${PORT} and click a button. Ctrl+C stops the server.`);
});
