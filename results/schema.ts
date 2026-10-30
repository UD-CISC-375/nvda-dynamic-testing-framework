/** Internal, evolving JSON contract shared by result producers and consumers. */
export interface Results {
  schemaVersion: 0;
  run: {
    timestamp: string;
    commit: string;
    siteUrl: string;
    scenarios: ScenarioResult[];
  };
}

export type ScenarioResult = {
  scenario: string;
  variant: string;
  states: StateResult[];
} & (
  | { verdict: "passed" | "failed"; skippedReason?: never }
  | { verdict: "skipped"; skippedReason: string }
);

export interface StateResult {
  index: number;
  trigger: string;
  domChangeSummary: string;
  treeDiff: TreeDiff;
  axe: {
    new: AxeViolation[];
    resolved: AxeViolation[];
    totalCount: number;
  };
  stable: boolean;
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
}
