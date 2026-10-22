// Local server for presentations: shows index.html, and runs the Playwright
// tests when its button is clicked. Start it with `npm run present`.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 4375;
// Repo root, so Playwright finds playwright.config.ts (and Team Y's baseURL).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Playwright's command-line entry point. Running it with `node` directly avoids
// npx, which on Windows is a .cmd file that spawn() can't start without a shell.
const PLAYWRIGHT_CLI = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");
// Same as `npm test`, limited to the accessibility-tree diff spec.
const TEST_ARGS = ["test", "menu-aria-tree.spec.ts", "--project=chromium"];

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
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });

    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, ...TEST_ARGS], {
      cwd: ROOT,
      // PLAYWRIGHT_HTML_OPEN=never: the config would otherwise open the HTML report
      // and keep serving it until Ctrl+C, so the run would never finish.
      // FORCE_COLOR=0: no terminal color codes in the text sent to the page.
      env: { ...process.env, PLAYWRIGHT_HTML_OPEN: "never", FORCE_COLOR: "0" },
    });
    // Send Playwright's output to the page as it is printed.
    child.stdout.pipe(res, { end: false });
    child.stderr.pipe(res, { end: false });
    child.on("close", (code) => {
      running = false;
      res.end(`\nFinished with exit code ${code} (${code === 0 ? "all passed" : "something failed"}).\n`);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

// "127.0.0.1" so only this computer can reach the server, not others on the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Open http://localhost:${PORT} and click the button. Ctrl+C stops the server.`);
});
