// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// Node built-ins for reading fixture files from disk.
import { readFileSync } from "fs";
import { join } from "path";
// Import the snapshot parsing helpers under test.
import { parseLine, buildTree } from "./helpers/parse-snapshot";

// Read a sample snapshot from tests/fixtures/snapshots (captured from real Playwright output).
const fixture = (file: string) => readFileSync(join(__dirname, "fixtures", "snapshots", file), "utf8");

// Each line below is copied from real Playwright 1.63 snapshot output.
test.describe("parseLine", () => {
  // Role, name, a valued state and a ref, all on one line.
  test("reads role, name, valued state and ref", () => {
    expect(parseLine(`  - heading "Results" [level=2] [ref=e3]`)).toEqual({
      indent: 2,
      role: "heading",
      name: "Results",
      ref: "e3",
      states: { level: "2" },
      active: false,
    });
  });

  // Bare markers like [expanded] become true; [active] and [cursor=pointer] are not states.
  test("reads true/false states and drops active and cursor markers", () => {
    const line = parseLine(`- button "Open" [expanded] [pressed] [active] [ref=e9] [cursor=pointer]`);
    expect(line?.states).toEqual({ expanded: true, pressed: true });
    expect(line?.active).toBe(true);
  });

  // Names escape quotes and backslashes the same way JSON does.
  test("decodes escaped quotes and backslashes in names", () => {
    expect(parseLine(String.raw`- button "It's \"quoted\" \\ back" [ref=e3]`)?.name).toBe(
      String.raw`It's "quoted" \ back`,
    );
  });

  // A name containing ": " makes Playwright single-quote the whole key.
  test("handles a single-quoted key whose name contains a colon", () => {
    const line = parseLine(`  - 'button "Save: now" [ref=e2]'`);
    expect(line?.name).toBe("Save: now");
    expect(line?.ref).toBe("e2");
  });

  // Text after the colon is returned, with YAML double quotes removed.
  test("reads inline text, including quoted text", () => {
    expect(parseLine(`- paragraph [ref=e4]: Plain bold text`)?.text).toBe("Plain bold text");
    expect(parseLine(String.raw`- paragraph: "\"starts with quote\""`)?.text).toBe(`"starts with quote"`);
  });

  // "- text:" and "/url:" lines have a special key instead of a role.
  test("reads text: and /url: lines", () => {
    expect(parseLine(`    - text: Email`)).toMatchObject({ role: "text", text: "Email" });
    expect(parseLine(`        - /url: "#x"`)).toMatchObject({ role: "/url", text: "#x" });
  });

  // Refs are opaque: iframe and post-reload refs look like f1e1, not just e1.
  test("keeps iframe-style refs as opaque strings", () => {
    expect(parseLine(`    - button "Inside" [ref=f1e2]`)?.ref).toBe("f1e2");
  });

  // A line ending in ":" with nothing after it has children but no text.
  test("has no text when the line only opens children", () => {
    expect(parseLine(`- link "About us" [ref=e7] [cursor=pointer]:`)?.text).toBeUndefined();
  });

  // Blank lines aren't nodes.
  test("returns undefined for a line that is not a list item", () => {
    expect(parseLine("")).toBeUndefined();
  });
});

test.describe("buildTree", () => {
  // The default-mode snapshot of the basic sample page.
  const tree = buildTree(fixture("basic.default.yaml"));

  // Indented lines become children; "- main" is the only top-level node.
  test("nests lines by indentation", () => {
    expect(tree).toHaveLength(1);
    expect(tree[0].role).toBe("main");
    // Two levels down: main > list > listitem.
    const list = tree[0].children.find((n) => n.role === "list");
    expect(list?.children.map((n) => n.role)).toEqual(["listitem", "listitem"]);
  });

  // "paragraph: Plain bold text" puts its text in a child node, not on the paragraph.
  test("turns inline text into a child text node", () => {
    const paragraph = tree[0].children.find((n) => n.role === "paragraph");
    expect(paragraph?.value).toBeUndefined();
    expect(paragraph?.children).toEqual([{ role: "text", value: "Plain bold text", states: {}, children: [] }]);
  });

  // A form field's inline text is its value.
  test("puts a form field's inline text in value", () => {
    const textbox = tree[0].children.find((n) => n.role === "textbox");
    expect(textbox).toMatchObject({ name: "Email", value: "a@b.c", children: [] });
  });

  // "- text:" lines and "/url:" lines become nodes holding their text in value.
  test("keeps text: lines and /url: lines as nodes with a value", () => {
    expect(tree[0].children).toContainEqual({ role: "text", value: "Email", states: {}, children: [] });
    const link = tree[0].children.find((n) => n.role === "link");
    expect(link?.children).toEqual([{ role: "/url", value: "/about", states: {}, children: [] }]);
  });

  // States and decoded names come through on the tree nodes.
  test("keeps names, valued states and true/false states", () => {
    expect(tree[0].children[0]).toMatchObject({
      role: "heading",
      name: String.raw`Say "hi" \ now`,
      states: { level: "2" },
    });
    expect(tree[0].children.find((n) => n.name === "Open")?.states).toEqual({ expanded: true });
  });
});
