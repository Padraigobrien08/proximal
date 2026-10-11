import { expect, test } from "@playwright/test";

// Runs after the showcase (same database), on a different topic.
test("resume opens the exact checkpoint phase without duplicates; flagging excludes a judgement but keeps history", async ({ page }) => {
  await page.goto("/topics/demo-topic-likelihood");
  await page.getByTestId("choose-study").click();
  await page.getByTestId("start-review").click();
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S1-A");
  const sessionUrl = page.url();
  await page.getByTestId("demo-example-correct").click();
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S2-A");

  // U08: the overview offers to resume the exact persisted phase, first in today's session.
  await page.goto("/");
  await expect(page.getByTestId("recommendation")).toContainText("Pick up where you left off");
  await expect(page.getByTestId("plan-row").first()).toContainText("1 of 2 answers saved");
  await page.getByTestId("continue").click();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S2-A");
  await expect(page.getByTestId("progress")).toContainText("1 answer saved");

  // Starting the same check from the topic page resumes rather than duplicating.
  await page.goto("/topics/demo-topic-likelihood");
  await page.getByTestId("choose-study").click();
  await page.getByTestId("start-review").click();
  await expect(page).toHaveURL(sessionUrl);

  await page.getByTestId("demo-example-correct").click();
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("result-S2")).toContainText("Checked");

  // U12: flag the second judgement.
  const s2 = page.getByTestId("result-S2");
  await s2.getByText("Feedback on your answer").click();
  await s2.getByRole("button", { name: "Flag judgement" }).click();
  const dialog = page.getByRole("dialog", { name: "Flag this judgement?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason (optional)").fill("Checking the flag flow");
  await dialog.getByRole("button", { name: "Exclude judgement" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("result-S2")).toContainText("This judgement is excluded from your learning record");
  await expect(page.getByTestId("result-S2")).toContainText("Not started");

  // Counts and topic history reflect the exclusion; the history keeps the record.
  await page.goto("/");
  await expect(page.getByTestId("course-demo-course")).toContainText("2 of 6 subtopics checked on your own");
  await page.goto("/topics/demo-topic-likelihood");
  await expect(page.getByTestId("subtopic-U1")).toContainText("Checked");
  await expect(page.getByTestId("subtopic-U2")).toContainText("Not started");
  await page.getByText("Answer history").click();
  await expect(page.getByTestId("evidence-list")).toContainText("Judgement excluded");
});
