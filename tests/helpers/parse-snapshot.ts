// Import only the TreeSnapshot type (the default + AI-mode snapshot pair).
import type { TreeSnapshot } from "./aria-tree";

// One node of the parsed accessibility tree.
export type AriaNode = {
  // The role ("button", "heading"), or "text" / "/url" / "/placeholder" for those lines.
  role: string;
  // The accessible name, if the node has one.
  name?: string;
  // The AI-mode ref id, kept as an opaque string ("e12", "f1e1", ...).
  ref?: string;
  // Bracket states: [level=2] -> { level: "2" }, [expanded] -> { expanded: true }.
  states: Record<string, string | true>;
  // A form field's value, a text node's text, or a /url target.
  value?: string;
  // Nodes nested under this one, in order.
  children: AriaNode[];
};

// One line of an aria snapshot, split into its parts (nesting is not handled here).
export type ParsedLine = {
  // Number of leading spaces; deeper lines are children of shallower ones.
  indent: number;
  // The role ("button", "heading"), or a special key like "text" or "/url".
  role: string;
  // The accessible name inside quotes, if the line has one.
  name?: string;
  // The [ref=...] id from AI mode, kept as an opaque string ("e12", "f1e1", ...).
  ref?: string;
  // Bracket states: [level=2] -> { level: "2" }, [expanded] -> { expanded: true }.
  states: Record<string, string | true>;
  // True if the line had the [active] focus marker (AI mode only).
  active: boolean;
  // Whatever followed "key: " on the line, with YAML quotes removed.
  text?: string;
};

// Undo YAML single quotes: 'It''s' -> It's
function unquoteSingle(s: string): string {
  return s.slice(1, -1).replace(/''/g, "'");
}

// Remove YAML quotes from a value; double-quoted values use the same escapes as JSON.
function unquote(s: string): string {
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return unquoteSingle(s);
  return s;
}

// Index of the quote that closes the "..." string starting at `start`, skipping \" escapes.
function closingQuote(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    // A backslash escapes the next character, so jump over both.
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  // No closing quote: treat the rest of the line as the string.
  return s.length - 1;
}

// Split "key: value" into its key and the part after the key (":", ": value", or "").
function splitKey(rest: string): [key: string, after: string] {
  // Playwright single-quotes the whole key when the name contains ": ".
  if (rest.startsWith("'")) {
    // Find the closing ' that isn't part of a doubled '' escape.
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === "'" && rest[i + 1] === "'") i += 2;
      else if (rest[i] === "'") break;
      else i++;
    }
    // Everything up to and including the closing quote is the key.
    return [unquoteSingle(rest.slice(0, i + 1)), rest.slice(i + 1)];
  }
  // Otherwise the key ends at the first ":" that isn't inside the "name".
  for (let i = 0; i < rest.length; i++) {
    // Skip over a quoted name so a ":" inside it doesn't end the key.
    if (rest[i] === '"') i = closingQuote(rest, i);
    else if (rest[i] === ":") return [rest.slice(0, i), rest.slice(i)];
  }
  // No ":" at all: the whole line is the key.
  return [rest, ""];
}

// Parse one snapshot line, or return undefined for lines that aren't "- ..." items.
export function parseLine(line: string): ParsedLine | undefined {
  // Count leading spaces to know how deep this line is.
  const indent = line.length - line.trimStart().length;
  // Drop the indentation.
  const rest = line.trimStart();
  // Every node line starts with "- "; anything else (blank lines) is skipped.
  if (!rest.startsWith("- ")) return undefined;
  // Separate the key (role, name, states) from what follows the ":".
  const [key, after] = splitKey(rest.slice(2));

  // The role is the first word of the key.
  const role = key.match(/^\S+/)?.[0] ?? "";
  // The part of the key after the role: optional "name", then [states].
  let tail = key.slice(role.length).trimStart();
  // Read the quoted name, if there is one.
  let name: string | undefined;
  if (tail.startsWith('"')) {
    // Find where the name ends, then decode its \" and \\ escapes with JSON.parse.
    const end = closingQuote(tail, 0);
    name = JSON.parse(tail.slice(0, end + 1));
    // Keep only what comes after the name.
    tail = tail.slice(end + 1);
  }

  // Collect the [key] and [key=value] markers after the name.
  const states: Record<string, string | true> = {};
  let ref: string | undefined;
  let active = false;
  for (const [, k, v] of tail.matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)) {
    // [ref=...] is the element id, not a state.
    if (k === "ref") ref = v;
    // [active] marks focus; it is reported separately, not as a state.
    else if (k === "active") active = true;
    // [cursor=pointer] is a visual hint, not an accessibility state.
    else if (k === "cursor") continue;
    // A bare marker like [expanded] means true; otherwise keep the value string.
    else states[k] = v ?? true;
  }

  // The text after ": " (empty means the line only has children, or nothing).
  const raw = after.replace(/^:/, "").trim();
  // Remove YAML quotes from the text, if there is any.
  const text = raw ? unquote(raw) : undefined;
  return { indent, role, name, ref, states, active, text };
}

// Roles whose inline text is the field's current value rather than visible text.
const FORM_FIELD_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
]);

// Make a tree node from one parsed line (children are attached by buildTree).
function toNode(line: ParsedLine): AriaNode {
  // The parts every node shares; children start empty.
  const node: AriaNode = {
    role: line.role,
    name: line.name,
    ref: line.ref,
    states: line.states,
    children: [],
  };
  // No text after the colon: nothing more to add.
  if (line.text === undefined) return node;
  // "text:", "/url:" and "/placeholder:" lines hold their text directly.
  if (line.role === "text" || line.role.startsWith("/")) node.value = line.text;
  // A form field's inline text is its value ("textbox "Email": a@b.c").
  else if (FORM_FIELD_ROLES.has(line.role)) node.value = line.text;
  // Any other role's inline text is visible content, so it becomes a child text node.
  else node.children.push({ role: "text", value: line.text, states: {}, children: [] });
  return node;
}

// Build the tree for one snapshot, using indentation to decide who is whose child.
export function buildTree(snapshot: string): AriaNode[] {
  // The top-level nodes (a snapshot can have more than one).
  const roots: AriaNode[] = [];
  // The chain of open parents from the top level down to the last node added.
  const stack: { indent: number; node: AriaNode }[] = [];
  for (const raw of snapshot.split("\n")) {
    // Parse the line; skip anything that isn't a "- ..." node line.
    const line = parseLine(raw);
    if (!line) continue;
    const node = toNode(line);
    // Close parents that are at the same depth or deeper; they can't own this line.
    while (stack.length && stack[stack.length - 1].indent >= line.indent) stack.pop();
    // The nearest remaining parent owns this node; with none left, it's top-level.
    const parent = stack[stack.length - 1];
    (parent ? parent.node.children : roots).push(node);
    // This node may own the lines that follow, so it becomes the newest open parent.
    stack.push({ indent: line.indent, node });
  }
  return roots;
}

// An AI-mode node in a flattened sibling list, plus where the next sibling starts.
type Candidate = { node: AriaNode; next: number };

// List AI-mode siblings in order, with each generic followed by its own children.
// Default mode leaves unnamed generic wrappers out, so their children count as siblings.
function flatten(nodes: AriaNode[], out: Candidate[] = []): Candidate[] {
  for (const node of nodes) {
    const entry = { node, next: 0 };
    out.push(entry);
    // A generic's children are listed right after it, as if they were its siblings.
    if (node.role === "generic") flatten(node.children, out);
    // The next sibling starts after this node and anything listed under it.
    entry.next = out.length;
  }
  return out;
}

// Copy refs from AI-mode nodes onto matching default-mode nodes, by order and role only.
// Names are never compared. Limitation: if an AI-only node (e.g. an aria-hidden button)
// comes before a real node of the same role, the real node gets the hidden node's ref.
function mergeRefs(defaults: AriaNode[], ai: AriaNode[]): void {
  // AI siblings in order, with generic wrappers opened up.
  const candidates = flatten(ai);
  // Position of the first AI candidate not yet used.
  let i = 0;
  for (const node of defaults) {
    // Text, /url and /placeholder nodes never have refs, so there's nothing to match.
    if (node.role === "text" || node.role.startsWith("/")) continue;
    // Skip AI-only nodes until one has the same role and a ref.
    let j = i;
    while (j < candidates.length) {
      const c = candidates[j].node;
      if (c.role === node.role && c.ref !== undefined) break;
      j++;
    }
    // No match (e.g. <option> lines have no ref): leave this node without one.
    if (j === candidates.length) continue;
    // Take the ref, then match the two nodes' children the same way.
    const match = candidates[j];
    node.ref = match.node.ref;
    mergeRefs(node.children, match.node.children);
    // Later siblings can only match after this one (and outside it, if it was a generic).
    i = match.next;
  }
}

// Build one tree: content from default mode, refs from AI mode.
export function parseSnapshot(snap: TreeSnapshot): { tree: AriaNode[] } {
  // Content: what a screen reader gets, so aria-hidden text never gets in.
  const tree = buildTree(snap.content);
  // Refs come from AI mode; its tree is only used for matching, never for content.
  mergeRefs(tree, buildTree(snap.refs));
  return { tree };
}
