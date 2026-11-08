import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEPLOYED_ACCORDION =
  "https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/accordion.html";

export function isolatedAccordionUrl(cwd = process.cwd()): string {
  const candidates = [
    resolve(cwd, "../nvda-dynamic-testing-webpage/public/accordion.html"),
    resolve(cwd, "tests/fixtures/accordion.html"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      return pathToFileURL(file).href;
    }
  }
  return DEPLOYED_ACCORDION;
}
