import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_XML = resolve(__dirname, "../../samples/library.xml");
const LIBRARY_XSD = resolve(__dirname, "../../samples/library.xsd");
// library.xml omits the <price> element the schema requires, once per book.
const EXPECTED_ERRORS = "3 errors";

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, "page must not scroll horizontally").toBeLessThanOrEqual(clientWidth);
}

/** Load the sample document; the diagram is the default view on every tier. */
async function loadXml(page: Page) {
  await page.goto("/");
  await page.locator('input[type="file"]').first().setInputFiles(LIBRARY_XML);
  await expect(page.locator(".react-flow")).toBeVisible();
}

/** Load the schema through the second (XSD) loader. Phones auto-collapse the
 *  Files section after the XML load, so expand it first there. */
async function loadXsd(page: Page) {
  const files = page.getByRole("button", { name: /Files/ });
  if ((await files.getAttribute("aria-expanded")) === "false") await files.click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(LIBRARY_XSD);
}

test.describe("phone", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone project only");
  });

  test("landing page fits the viewport and folds secondary header actions into a menu", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "XML Online Viewer" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "About this app" })).toBeHidden();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "About this app" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "About this app" })).toBeHidden();
  });

  test("bottom nav walks diagram → tree → validation and an error jumps back to the view", async ({ page }) => {
    await loadXml(page);
    await expectNoHorizontalOverflow(page);

    // Files collapsed itself to make room for the document.
    await expect(page.getByRole("button", { name: /Files/ })).toHaveAttribute("aria-expanded", "false");

    const nav = page.getByRole("navigation", { name: "Panes" });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("button", { name: "Diagram" })).toHaveAttribute("aria-pressed", "true");

    // Compact toolbar keeps export behind a menu.
    await expect(page.getByRole("button", { name: "Export SVG" })).toBeHidden();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Export SVG" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Tree pane: tapping a row selects it but stays on the tree.
    await nav.getByRole("button", { name: "Tree" }).click();
    await expect(page.locator(".react-flow")).toBeHidden();
    const section = page.getByRole("treeitem").filter({ hasText: "section" }).first();
    await expect(section).toBeVisible();
    await section.click();
    await expect(section).toHaveAttribute("aria-selected", "true");
    await expect(nav.getByRole("button", { name: "Tree" })).toHaveAttribute("aria-pressed", "true");
    await expectNoHorizontalOverflow(page);

    // Validation pane, then load the schema and pick an error.
    await nav.getByRole("button", { name: "Validation" }).click();
    await expect(page.getByText("Load XML data and an XSD schema to validate.")).toBeVisible();
    await loadXsd(page);
    // The schema load collapsed Files again so the result has the screen.
    await expect(page.getByRole("button", { name: /Files/ })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText(EXPECTED_ERRORS)).toBeVisible();
    await page.getByRole("listitem").filter({ hasText: "Missing child element" }).first().click();

    // Back on the tree with the erroneous <book> selected.
    await expect(nav.getByRole("button", { name: "Tree" })).toHaveAttribute("aria-pressed", "true");
    const selected = page.getByRole("treeitem").filter({ hasText: "book" }).and(page.locator('[aria-selected="true"]'));
    await expect(selected.first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("header search switches to the tree and focuses the search box", async ({ page }) => {
    await loadXml(page);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.locator(".react-flow")).toBeHidden();
    await expect(page.getByPlaceholder(/^Search tag/)).toBeFocused();
  });
});

test.describe("tablet", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "tablet", "tablet project only");
  });

  test("shows the tab strip with validation in a drawer", async ({ page }) => {
    await loadXml(page);
    await expectNoHorizontalOverflow(page);

    await expect(page.getByRole("navigation", { name: "Panes" })).toBeHidden();
    await expect(page.getByRole("tab", { name: "Tree" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Diagram" })).toBeVisible();

    const drawer = page.getByRole("complementary", { name: "Validation" });
    await expect(drawer).toBeHidden();
    await page.getByRole("button", { name: "Show validation" }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Validate" })).toBeVisible();

    await loadXsd(page);
    await expect(drawer.getByText(EXPECTED_ERRORS)).toBeVisible();
    // Picking an error keeps the drawer open on tablets.
    await drawer.getByRole("listitem").filter({ hasText: "Missing child element" }).first().click();
    await expect(drawer).toBeVisible();

    await page.getByRole("button", { name: "Close validation" }).click();
    await expect(drawer).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});
