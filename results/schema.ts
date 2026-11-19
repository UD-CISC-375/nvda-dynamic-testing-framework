/** Internal, evolving JSON contract shared by result producers and consumers. */
export interface Results {
  schemaVersion: 0;
  run: {
    timestamp: string;
    commit: string;
    siteUrl: string;
    scope?: string;
    scenarios: ScenarioResult[];
  };
}

export type ScenarioResult = {
  scenario: string;
  variant: string;
  /** Marks checks whose accessibility behavior cannot be assessed by axe alone. */
  nvdaOnly?: boolean;
  executionNote?: string;
  states: StateResult[];
} & (
  | { verdict: "passed" | "failed"; skippedReason?: never }
  | { verdict: "skipped"; skippedReason: string }
);

export interface StateResult {
  index: number;
  trigger: string;
  domChangeSummary: string;
  /** Optional wording for user-facing effects that a structural tree diff cannot explain. */
  assistiveTechChanges?: string[];
  treeDiff: TreeDiff;
  axe: {
    new: AxeViolation[];
    resolved: AxeViolation[];
    totalCount: number;
  };
  stable: boolean | null;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TreeNode {
  id: string;
  properties: { [name: string]: JsonValue };
  children: TreeNode[];
}

export interface TreeDiff {
  added: SubtreeChange[];
  removed: SubtreeChange[];
  changed: {
    nodeId: string;
    /** Optional accessible-tree metadata used to describe a change in plain language. */
    role?: string;
    name?: string;
    properties: {
      name: string;
      before?: JsonValue;
      after?: JsonValue;
    }[];
  }[];
  reordered: {
    parentId: string;
    before: string[];
    after: string[];
  }[];
}

export interface SubtreeChange {
  parentId: string | null;
  index: number;
  subtree: TreeNode;
}

export interface AxeViolation {
  rule: string;
  target: JsonValue[];
  impact?: string;
  /** axe's rule summary, documentation URL, failure details, and affected HTML. */
  help: string;
  helpUrl: string;
  failureSummary: string;
  html: string;
}
