import path from "node:path";
import { expect, test } from "@playwright/test";

test("sample PDF import: extraction, draft edit, explicit approval, page refs, review disabled until a question is approved", async ({ page }) => {
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
  // Approved modules lead with topics and subtopic levels; objective detail is one click away.
  await expect(page.getByTestId("module-summary")).toContainText("0 of 5 subtopics checked on your own");
  const firstTopic = page.getByTestId(/^topic-row-/).first();
  await expect(firstTopic).toContainText("Model notation (edited)");
  await page.getByText("Objectives and skills").click();
  await expect(page.getByText("Optional").first()).toBeVisible();
  await expect(page.getByText("Reviewed assessment questions needed").first()).toBeVisible();

  // Imported topic: no-help checks disabled with an honest reason.
  await firstTopic.click();
  await expect(page.getByText("No-help checks need an approved question.")).toBeVisible();
  await page.getByTestId("choose-study").click();
  await expect(page.getByTestId("start-review")).toBeDisabled();
  await expect(page.getByTestId("start-review")).toContainText("Reviewed assessment questions needed.");

  // Draft questions (offline: the authored sample bank), key closed; approving one for checks enables review.
  await page.reload();
  const panel = page.getByTestId("question-drafts");
  await panel.getByTestId(/^draft-questions-/).first().click();
  await expect(panel.getByText("Draft questions ready.")).toBeVisible();
  await expect(panel.getByTestId("answer-key")).toHaveCount(0);
  await panel.getByTestId("approve-checks").first().click();
  await expect(panel.getByText("Approved for no-help checks.")).toBeVisible();
  await expect(panel.getByText("Used in checks", { exact: true })).toBeVisible();

  // Opening the second draft's key leaves only practice approval.
  await panel.getByTestId("reveal-key").first().click();
  await panel.getByTestId("confirm-reveal").click();
  await expect(panel.getByTestId("answer-key")).toBeVisible();
  await expect(panel.getByTestId("approve-checks")).toHaveCount(0);
  await panel.getByTestId("approve-practice").click();
  await expect(panel.getByText("Practice only", { exact: true })).toBeVisible();

  await page.getByTestId("choose-study").click();
  await expect(page.getByTestId("start-review")).toBeEnabled();
});
