// Local server for presentations: shows index.html, and runs the Playwright
// tests when its button is clicked. Start it with `npm run present`.
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
// Like `npm run test:headed` (visible browser), limited to the accessibility-tree
// diff spec. The JSON reporter prints the whole run, attachments included, as one
// JSON document on stdout, which is easier to pick the diffs out of than plain text.
const TEST_ARGS = ["test", "menu-aria-tree.spec.ts", "--project=chromium", "--headed", "--reporter=json"];

// Only one run at a time; a second click while running is refused.
let running = false;

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const html = await readFile(new URL("index.html", import.meta.url));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && req.url === "/run") {
    if (running) {
      res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Tests are already running.\n");
      return;
    }
    running = true;

    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, ...TEST_ARGS], {
      cwd: ROOT,
      // FORCE_COLOR=0: no terminal color codes in any error text sent to the page.
      // SLOW_MO=500: playwright.config.ts pauses 500 ms before each browser
      // action, so the audience can see the menu open.
      env: { ...process.env, FORCE_COLOR: "0", SLOW_MO: "500" },
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
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Playwright exited with code ${code}.\n${stderr}${stdout}`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ exitCode: code, tests }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

// Turn Playwright's JSON report into [{ title, status, error, added, removed }],
// one entry per test, keeping only what the page shows.
function summarize(report) {
  const tests = [];
  // Suites can nest (file > describe > ...), so walk them recursively.
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        // The last result is the final attempt (earlier ones are retries).
        const result = test.results.at(-1);
        // The spec attaches its diff as "tree-<variant>-diff.json", body in base64.
        const diffAttachment = result.attachments.find((a) => /^tree-.*-diff\.json$/.test(a.name));
        const diff = diffAttachment
          ? JSON.parse(Buffer.from(diffAttachment.body, "base64").toString("utf8"))
          : { added: [], removed: [] };
        tests.push({
          title: spec.title,
          status: result.status,
          // First line of the failure message, if the test failed.
          error: result.errors[0]?.message?.split("\n")[0],
          added: diff.added,
          removed: diff.removed,
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
  console.log(`Open http://localhost:${PORT} and click the button. Ctrl+C stops the server.`);
});
