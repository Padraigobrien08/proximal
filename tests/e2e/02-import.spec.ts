import path from "node:path";
import { expect, test } from "@playwright/test";

test("sample PDF import: extraction, draft edit, explicit approval, page refs, review disabled", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("toggle-import").click();
  await page.getByTestId("import-file").setInputFiles(path.resolve("fixtures/sample-lecture.pdf"));
  await page.getByTestId("import-submit").click();
  await expect(page.getByText("Recognised the authored sample lecture")).toBeVisible();
  await expect(page.getByText("6 page(s) extracted")).toBeVisible();
  await page.getByTestId("open-draft").click();

  await expect(page.getByText("Draft – not yet approved")).toBeVisible();
  await expect(page.getByTestId("unit")).toHaveCount(6);
  // Source links show the PDF page for each unit.
  const links = page.getByTestId("source-page-link");
  await expect(links.nth(0)).toContainText("PDF page 1");
  await expect(links.nth(4)).toContainText("PDF page 5");
  await expect(links.nth(5)).toContainText("PDF page 6");

  // Edit a title, toggle required, delete an unsupported objective, save.
  await page.getByTestId("unit-title").first().fill("Model notation (edited)");
  await page.getByTestId("skill-required").first().uncheck();
  await page.getByTestId("unit").nth(5).getByRole("button", { name: "Delete unsupported objective" }).click();
  await expect(page.getByTestId("approve")).toBeDisabled();
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await expect(page.getByTestId("unit")).toHaveCount(5);

  // Explicit approval.
  await page.getByTestId("approve").click();
  await expect(page.getByText("Curriculum approved. Objectives are now frozen.")).toBeVisible();
  await expect(page.getByText("Model notation (edited)")).toBeVisible();
  await expect(page.getByText("Optional").first()).toBeVisible();
  await expect(page.getByText("Reviewed assessment questions needed").first()).toBeVisible();

  // Imported topic: review disabled with an honest reason.
  await page.getByRole("link", { name: "Open topic" }).first().click();
  await expect(page.getByText("Reviewed assessment questions needed.").first()).toBeVisible();
  await expect(page.getByTestId("start-review")).toBeDisabled();
  await expect(page.getByText("Independent checks are disabled until an owner-authored")).toBeVisible();
});
