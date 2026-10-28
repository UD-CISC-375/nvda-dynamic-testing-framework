import { test, expect, Page } from "@playwright/test";
import { runAxe } from "./helpers/axe";

const comboboxUrl = (variant: "accessible" | "broken") =>
  `#/dynamic/combobox?variant=${variant}`;

async function openCombobox(page: Page, variant: "accessible" | "broken") {
  await page.goto(comboboxUrl(variant));
  await expect(page.getByTestId("variant")).toHaveText(variant);
  await expect(page.getByTestId("scenario-root")).toBeVisible();
}

test("accessible: autocomplete supports keyboard selection and announces results", async ({
  page,
}, testInfo) => {
  await openCombobox(page, "accessible");

  const combobox = page.getByRole("combobox", { name: "Favorite fruit" });
  await expect(combobox).toHaveAttribute("aria-expanded", "false");

  await combobox.fill("ap");
  await expect(combobox).toHaveAttribute("aria-expanded", "true");

  const listbox = page.getByRole("listbox", { name: "Fruits" });
  await expect(listbox.getByRole("option")).toHaveCount(6);
  await expect(listbox.getByRole("option")).toHaveText([
    "Apple",
    "Apricot",
    "Grape",
    "Grapefruit",
    "Papaya",
    "Pineapple",
  ]);
  await expect(page.getByRole("status")).toHaveText("6 results available.");

  const violations = await runAxe(page, testInfo, "list-open");
  expect(violations.map((violation) => violation.id)).toEqual([]);
  console.log(
    "[combobox] accessible suggestions:",
    JSON.stringify({
      expanded: await combobox.getAttribute("aria-expanded"),
      options: await listbox.getByRole("option").allInnerTexts(),
      status: await page.getByRole("status").innerText(),
      axeViolations: violations.map((violation) => violation.id),
    }),
  );

  await combobox.press("ArrowDown");
  await expect(combobox).toHaveAttribute(
    "aria-activedescendant",
    "fruit-option-0",
  );
  await expect(
    listbox.getByRole("option", { name: "Apple", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  console.log(
    "[combobox] accessible keyboard selection:",
    JSON.stringify({
      activeDescendant: await combobox.getAttribute("aria-activedescendant"),
      selectedOption: "Apple",
    }),
  );

  await combobox.press("Enter");
  await expect(combobox).toHaveValue("Apple");
  await expect(combobox).toHaveAttribute("aria-expanded", "false");

  await combobox.fill("ap");
  await combobox.press("Escape");
  await expect(combobox).toHaveAttribute("aria-expanded", "false");
  console.log(
    "[combobox] accessible Escape:",
    JSON.stringify({
      value: await combobox.inputValue(),
      expanded: await combobox.getAttribute("aria-expanded"),
    }),
  );
});

test("broken: autocomplete suggestions are mouse-only and expose axe violations", async ({
  page,
}, testInfo) => {
  await openCombobox(page, "broken");

  const input = page.getByTestId("combobox");
  await input.fill("ap");

  const violations = await runAxe(page, testInfo, "list-open");
  expect(violations.map((violation) => violation.id)).toEqual(
    expect.arrayContaining(["aria-required-parent", "list"]),
  );

  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByTestId("option-apple")).toBeVisible();
  console.log(
    "[combobox] broken semantics:",
    JSON.stringify({
      comboboxCount: await page.getByRole("combobox").count(),
      listboxCount: await page.getByRole("listbox").count(),
      optionAppleVisible: await page.getByTestId("option-apple").isVisible(),
      axeViolations: violations.map((violation) => violation.id),
    }),
  );

  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("ap");
  console.log(
    "[combobox] broken keyboard attempt:",
    JSON.stringify({ value: await input.inputValue() }),
  );

  await page.getByTestId("option-apple").click();
  await expect(input).toHaveValue("Apple");
  console.log(
    "[combobox] broken mouse selection:",
    JSON.stringify({ value: await input.inputValue() }),
  );
});
