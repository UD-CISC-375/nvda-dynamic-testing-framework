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

// Undo YAML single quotes: 'It''s' -> It's ('' is an escaped ').
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
