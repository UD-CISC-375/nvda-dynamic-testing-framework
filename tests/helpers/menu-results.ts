import type { Locator, TestInfo } from "@playwright/test";
import type { Result } from "axe-core";
import type { AxeViolation, ScenarioResult } from "../../results/schema";
import type { ScenarioEntry } from "./scenarios";

type MenuSnapshot = {
  button: string;
  expanded: string | null;
  violations: AxeViolation[];
};

function findings(results: Result[]): AxeViolation[] {
  return results.flatMap((result) =>
    result.nodes.map((node) => {
      if (!node.failureSummary) {
        throw new Error(`axe did not supply a failure summary for ${result.id}`);
      }
      return {
        rule: result.id,
        target: node.target,
        impact: result.impact ?? undefined,
        help: result.help,
        helpUrl: result.helpUrl,
        failureSummary: node.failureSummary,
        html: node.html,
      };
    }),
  );
}

export async function captureMenuSnapshot(
  trigger: Locator,
  axeResults: Result[],
): Promise<MenuSnapshot> {
  return {
    button: await trigger.ariaSnapshot(),
    expanded: await trigger.getAttribute("aria-expanded"),
    violations: findings(axeResults),
  };
}

function findingKey(finding: AxeViolation): string {
  return JSON.stringify([finding.rule, finding.target]);
}

function buttonName(snapshot: string): string | undefined {
  return snapshot.match(/^- button "([^"]+)"/m)?.[1];
}

function labelButton(name: string | undefined): string {
  return name ? `button '${name}'` : "button with no accessible name";
}

export async function attachMenuResult(
  testInfo: TestInfo,
  scenarioMeta: Pick<ScenarioEntry, "id" | "axe">,
  variant: string,
  before: MenuSnapshot,
  after: MenuSnapshot,
  menu: Locator,
): Promise<void> {
  const menuTree = await menu.ariaSnapshot();
  const root = menuTree.match(/^- ([\w-]+)(?: "([^"]+)")?/);
  if (!root) throw new Error("The opened menu has no accessibility-tree root");

  const [, role, name] = root;
  const itemLines = [...menuTree.matchAll(/^\s*- (menuitemcheckbox|menuitemradio|menuitem|listitem)(?=\s|:|$)(?: "([^"]+)"|: (.*))?/gm)];
  const items = itemLines.length;
  const label = `${role}${name ? ` '${name}'` : ""}`;
  const changes = [`Added: ${label} with ${items} ${items === 1 ? "item" : "items"}`];
  const beforeName = buttonName(before.button);
  const afterName = buttonName(after.button);
  const button = labelButton(beforeName);
  if (beforeName !== afterName) {
    changes.push(`Changed: ${button}, name ${beforeName ?? "not exposed"} to ${afterName ?? "not exposed"}`);
  }
  if (before.expanded !== after.expanded) {
    changes.push(`Changed: ${button}, expanded ${before.expanded ?? "not exposed"} to ${after.expanded ?? "not exposed"}`);
  } else {
    changes.push(`The expanded state of the ${button} did not change (${before.expanded ?? "not exposed"}).`);
    if (after.expanded === null) {
      changes.push("The button does not expose whether it is expanded to assistive technology.");
    }
  }
  if (role !== "menu") {
    changes.push(`The opened content is exposed as ${role}, not as a menu.`);
  }

  // Compare rule and element, not just rule IDs: one rule can affect several elements.
  const beforeKeys = new Set(before.violations.map(findingKey));
  const afterKeys = new Set(after.violations.map(findingKey));
  const emptyDiff = { added: [], removed: [], changed: [], reordered: [] };
  const buttonChanges: { name: string; before: string | null; after: string | null }[] = [];
  if (beforeName !== afterName) {
    buttonChanges.push({ name: "name", before: beforeName ?? null, after: afterName ?? null });
  }
  if (before.expanded !== after.expanded) {
    buttonChanges.push({ name: "expanded", before: before.expanded, after: after.expanded });
  }
  // IDs are local to this recorded diff; Playwright's ARIA snapshot has no node IDs.
  const treeDiff = {
    added: [{
      parentId: null,
      index: 0,
      subtree: {
        id: "observed-menu",
        properties: { role, ...(name ? { name } : {}) },
        children: itemLines.map((item, index) => ({
          id: `observed-item-${index + 1}`,
          properties: { role: item[1], name: item[2] ?? item[3] ?? "" },
          children: [],
        })),
      },
    }],
    removed: [],
    changed: buttonChanges.length ? [{
      nodeId: "observed-trigger",
      role: "button",
      ...(beforeName ? { name: beforeName } : {}),
      properties: buttonChanges,
    }] : [],
    reordered: [],
  };
  const passed =
    button !== "button with no accessible name" &&
    before.expanded === "false" &&
    after.expanded === "true" &&
    role === "menu" &&
    items === 4 &&
    before.violations.length === 0 &&
    after.violations.length === 0;
  const result: ScenarioResult = {
    scenario: scenarioMeta.id,
    variant,
    verdict: passed ? "passed" : "failed",
    nvdaOnly: scenarioMeta.axe.nvdaOnly,
    states: [
      {
        index: 0,
        trigger: "Page loaded with the menu closed",
        domChangeSummary: "Baseline; no previous state.",
        treeDiff: emptyDiff,
        axe: { new: before.violations, resolved: [], totalCount: before.violations.length },
        stable: null,
      },
      {
        index: 1,
        trigger: `Clicked ${button}`,
        domChangeSummary: "The menu was opened.",
        assistiveTechChanges: changes,
        treeDiff,
        axe: {
          new: after.violations.filter((finding) => !beforeKeys.has(findingKey(finding))),
          resolved: before.violations.filter((finding) => !afterKeys.has(findingKey(finding))),
          totalCount: after.violations.length,
        },
        stable: true,
      },
    ],
  };
  await testInfo.attach("accessibility-scenario.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
}
