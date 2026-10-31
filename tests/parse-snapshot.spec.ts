// Import Playwright's test runner and assertion library (no browser is used in this file).
import { test, expect } from "@playwright/test";
// Node built-ins for reading fixture files from disk.
import { readFileSync } from "fs";
import { join } from "path";
// Import the snapshot parsing helpers under test.
import { parseLine, buildTree, parseSnapshot } from "./helpers/parse-snapshot";

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

test.describe("parseSnapshot", () => {
  // Default and AI-mode snapshots of the same basic sample page, taken together.
  const { tree } = parseSnapshot({
    content: fixture("basic.default.yaml"),
    refs: fixture("basic.ai.yaml"),
  });
  // Shorthand: the children of "- main".
  const main = tree[0].children;

  // Plain siblings get the ref of the AI node in the same position with the same role.
  test("copies refs onto matching nodes", () => {
    expect(tree[0].ref).toBe("e2");
    expect(main.map((n) => n.ref)).toEqual([
      "e3", // heading
      "e4", // paragraph
      "e5", // link
      "e6", // button "Actions"
      "e7", // button "Open"
      undefined, // text: Email
      "e9", // textbox "Email"
      "e11", // checkbox "Agree"
      undefined, // text: Agree
      "e12", // list
      "e16", // iframe
    ]);
  });

  // Refs are matched inside nested nodes too: main > list > listitem > link.
  test("copies refs at every depth", () => {
    const list = main.find((n) => n.role === "list");
    expect(list?.children.map((n) => n.ref)).toEqual(["e13", "e14"]);
    expect(list?.children[1].children.find((n) => n.role === "link")?.ref).toBe("e15");
  });

  // AI mode wraps "text: Email" + textbox in a generic; default mode doesn't. No generic is kept.
  test("skips AI-mode-only generic lines", () => {
    expect(JSON.stringify(tree)).not.toContain("generic");
  });

  // The iframe gets its ref, but its AI-only children (ref f1e2) are not content.
  test("gives the iframe its ref without adding AI-only children", () => {
    expect(main.find((n) => n.role === "iframe")).toMatchObject({ ref: "e16", children: [] });
  });

  // AI-mode names can differ (they can include aria-hidden text), so they're never compared.
  test("matches by order and role, never by name", () => {
    const { tree } = parseSnapshot({
      content: `- button "Save"\n- button "Cancel"`,
      refs: `- button "Save extra" [ref=e1]\n- button "Different" [ref=e2]`,
    });
    expect(tree.map((n) => [n.name, n.ref])).toEqual([
      ["Save", "e1"],
      ["Cancel", "e2"],
    ]);
  });
});

test.describe("parseSnapshot: focus, hidden content and reloads", () => {
  // A page with an aria-hidden icon inside a paragraph, an aria-hidden button, and focus on "Checkout".
  const hidden = parseSnapshot({
    content: fixture("hidden.default.yaml"),
    refs: fixture("hidden.ai.yaml"),
  });
  // The same kind of page captured after page.reload(), where refs look like f1e2.
  const reload = parseSnapshot({
    content: fixture("reload.default.yaml"),
    refs: fixture("reload.ai.yaml"),
  });

  // AI mode leaks aria-hidden text and nodes; the merged tree must not.
  test("aria-hidden text never appears in the merged tree", () => {
    const json = JSON.stringify(hidden.tree);
    expect(json).not.toContain("HIDDEN-ICON");
    expect(json).not.toContain("HIDDEN-BUTTON");
    // The paragraph's text comes from default mode, without the hidden icon.
    expect(hidden.tree[0].children[1].children[0].value).toBe("Total: $20");
  });

  // Focus is returned on its own, as the ref of the [active] line.
  test("returns focusedRef separately", () => {
    expect(hidden.focusedRef).toBe("e5");
    // It is the ref of the "Checkout" button in the merged tree.
    expect(hidden.tree[0].children.find((n) => n.ref === hidden.focusedRef)?.name).toBe("Checkout");
  });

  // With no [active] marker, there is no focused ref.
  test("focusedRef is undefined when nothing is marked active", () => {
    const { focusedRef } = parseSnapshot({
      content: fixture("basic.default.yaml"),
      refs: fixture("basic.ai.yaml"),
    });
    expect(focusedRef).toBeUndefined();
  });

  // After a reload, refs look like f1e2; they're copied as-is, never parsed.
  test("treats refs as opaque strings after a reload", () => {
    expect(reload.tree.map((n) => [n.role, n.ref])).toEqual([
      ["heading", "f1e2"],
      ["button", "f1e3"],
      ["link", "f1e4"],
    ]);
  });

  // <body> has focus here, so focusedRef is the ref of a skipped generic, not a tree node.
  test("focusedRef can point at a skipped generic when <body> has focus", () => {
    expect(reload.focusedRef).toBe("f1e1");
    expect(JSON.stringify(reload.tree)).not.toContain("f1e1");
  });
});
