import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const frameworkRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "nvda-dynamic-testing-webpage-"));
const siteRepository = join(tempRoot, "site");
const siteRoot = join(frameworkRoot, "site-root");
const servedSite = join(siteRoot, "nvda-dynamic-testing-webpage");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: frameworkRoot,
    stdio: "inherit",
    // Node refuses to spawn .cmd files without a shell since CVE-2024-27980 (EINVAL).
    // Safe here: every argument is a fixed literal, so nothing needs shell quoting.
    shell: command.endsWith(".cmd"),
    ...options,
  });
}

try {
  // Clone the same repo CI checks out (ci.yaml), not the old pre-transfer owner it redirects from.
  run("git", [
    "clone",
    "--depth",
    "1",
    "https://github.com/UD-CISC-375/nvda-dynamic-testing-webpage.git",
    siteRepository,
  ]);

  run(npm, ["ci"], { cwd: siteRepository });
  run(npm, ["run", "build"], {
    cwd: siteRepository,
    env: { ...process.env, CI: "false" },
  });

  rmSync(siteRoot, { recursive: true, force: true });
  mkdirSync(siteRoot, { recursive: true });
  cpSync(join(siteRepository, "build"), servedSite, { recursive: true });

  run(npm, ["run", "type-check"]);
  run(npm, ["test"], {
    env: {
      ...process.env,
      BASE_URL: "http://127.0.0.1:4173/nvda-dynamic-testing-webpage/",
      LOCAL_BUILD: "1",
      CI: "1",
    },
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
  if (existsSync(siteRoot)) {
    rmSync(siteRoot, { recursive: true, force: true });
  }
}
