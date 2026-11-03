
import type { APIRequestContext } from "@playwright/test";

// Defines the two possible versions of a scenario
export type Variant = "accessible" | "broken";

// Defines the categories that scenarios can belong to
export type Category = "live" | "disclosure" | "forms" | "dynamic";

// Action needed to prepare a scenario before testing
export interface SetupStep {
  action: "click" | "fill" | "press" | "waitFor";
  testid: string;
  value?: string;
}

// Defines the information stored for each scenario.
export interface ScenarioMeta {
  id: string;
  path: string;
  title: string;
  wcag: string[];
  category: Category;
  description: string;
  flaw: string;
  defaultDelay: number;
  setup: SetupStep[];
  expected: {
    accessible: string[];
    broken: string[];
  };
  axe: {
    brokenRules: string[];
    nvdaOnly: boolean;
    note?: string;
  };
}

// URLs generated for each scenario variant
export interface ScenarioEntry extends ScenarioMeta {
  urls: {
    accessible: string;
    broken: string;
  };
}

// Structure of the entire scenarios.json file
export interface ScenariosManifest {
  version: number;
  urlParams: {
    variant: string;
    delay: string;
  };
  scenarios: ScenarioEntry[];
}

const SUPPORTED_VERSION = 1;

// Uses scenarios.json and returns its scenario entries
// Uses Playwright's request context so the URL is relative to baseURL
export async function loadScenarios(
  request: APIRequestContext
): Promise<ScenarioEntry[]> {
  const response = await request.get("./scenarios.json");

  if (response.status() === 404) {
    throw new Error(
      `scenarios.json is missing at ${response.url()}. Check that the site was built with the manifest.`
    );
  }

  if (!response.ok()) {
    throw new Error(
      `Failed to load scenarios.json: HTTP ${response.status()} at ${response.url()}`
    );
  }

  const contentType = response.headers()["content-type"] ?? "";
  if (contentType.includes("text/html")) {
    throw new Error(
      `scenarios.json is missing at ${response.url()}. The server returned HTML instead of JSON.`
    );
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Could not read scenarios.json at ${response.url()}: invalid JSON or missing manifest.`
    );
  }

  if (!data || typeof data !== "object") {
    throw new Error("Invalid scenarios.json: expected an object.");
  }

  const manifest = data as Partial<ScenariosManifest>;

  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported scenarios.json version: manifest has ${manifest.version}, framework supports ${SUPPORTED_VERSION}.`
    );
  }

  if (!Array.isArray(manifest.scenarios)) {
    throw new Error(
      "Invalid scenarios.json: scenarios must be an array."
    );
  }

  return manifest.scenarios;
}
