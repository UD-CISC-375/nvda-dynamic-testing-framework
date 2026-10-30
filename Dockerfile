# syntax=docker/dockerfile:1
# Runs this repo's Playwright tests against the site, then serves the HTML
# report. Used by compose.yaml; the build context is this repo, either your
# local copy or a branch that Docker clones from GitHub.

# Microsoft's image ships the browsers for one Playwright version, so this must
# match @playwright/test in package-lock.json. The build stops if it doesn't.
ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION

WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN installed="$(npx playwright --version | awk '{print $2}')"; \
    if [ "$installed" != "$PLAYWRIGHT_VERSION" ]; then \
      echo "package-lock.json has Playwright $installed, but the Dockerfile uses $PLAYWRIGHT_VERSION." >&2; \
      echo "Update PLAYWRIGHT_VERSION at the top of the Dockerfile." >&2; \
      exit 1; \
    fi
COPY . .

# ---------------------------------------------------------------------------
# Helper file 1 of 2: playwright.docker.config.ts
# Written into the image only; it is not a file in this repo.
#
# Why it's needed: playwright.config.ts has the live GitHub Pages URL
# hard-coded as the site to test (older branches have no way to change it;
# newer ones read BASE_URL), and when CI is set it starts its own copy of the
# site (webServer) from a site-root folder that doesn't exist in this image.
# This wrapper keeps every other setting from playwright.config.ts, tests the
# site at BASE_URL instead (the webpage container by default, see
# compose.yaml), and turns webServer off.
# ---------------------------------------------------------------------------
COPY <<'EOF' playwright.docker.config.ts
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: process.env.BASE_URL || base.use?.baseURL },
  webServer: undefined,
});
EOF

# ---------------------------------------------------------------------------
# Helper file 2 of 2: run-tests.sh
# Written into the image only; it is not a file in this repo.
#
# Why it's needed: a container runs one command, but this takes several
# steps: run the tests with the wrapper above, remember whether they passed,
# then either keep serving the HTML report on port 9323 (for people) or, with
# SERVE_REPORT=0, exit with the test result (for CI). npm test can't do this:
# it doesn't serve the report, and chaining the two Playwright commands loses
# either the report or the pass/fail result.
# ---------------------------------------------------------------------------
COPY <<'EOF' run-tests.sh
#!/usr/bin/env bash
echo "Testing against: ${BASE_URL:-the baseURL in playwright.config.ts}"
npx playwright test --config=playwright.docker.config.ts --project=chromium
status=$?
echo "Tests finished with exit code $status."
if [ "${SERVE_REPORT:-1}" = "1" ]; then
  echo "Report: http://localhost:${REPORT_PORT:-9323} on the host. Stop with: docker compose down"
  # 0.0.0.0 instead of localhost, so the published port reaches it.
  exec npx playwright show-report --host 0.0.0.0 --port 9323
fi
exit $status
EOF

# Tells the framework's config that nobody is watching: it retries failed
# tests and doesn't try to open the report itself.
ENV CI=1
EXPOSE 9323
CMD ["bash", "run-tests.sh"]
