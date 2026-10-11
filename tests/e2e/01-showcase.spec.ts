import { expect, test, type Response } from "@playwright/test";

test("P0 showcase: no-help explanation, calculation gap, correction as practice, scheduled fresh check, persistence", async ({ page }) => {
  // U01: a new workspace shows a real plan and real counts, no invented progress.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeAttached();
  await expect(page.getByTestId("shell-provider")).toContainText("Offline demo · supplied examples only");
  await expect(page.getByTestId("recommendation")).toContainText("Today's session");
  await expect(page.getByTestId("plan-row").first()).toContainText("Learn");
  await expect(page.getByTestId("plan-row").first()).toContainText("Model notation · Dataset likelihood");
  await expect(page.getByTestId("course-demo-course")).toContainText("0 of 6 subtopics checked on your own");

  // The showcase enters BCE through its module and topic pages (the plan is not rigged).
  await page.getByRole("link", { name: "AI classification demo" }).first().click();
  await expect(page.getByTestId("module-summary")).toContainText("0 of 6 subtopics checked on your own");
  await page.getByTestId("topic-row-demo-topic-bce").click();
  await expect(page.getByRole("heading", { name: "Binary cross-entropy", exact: true })).toBeVisible();
  await expect(page.getByTestId("subtopic-U4")).toContainText("Not started");

  // U03: record every API payload while the checkpoint is open.
  const checkpointPayloads: string[] = [];
  const capture = async (r: Response) => {
    if (r.url().includes("/api/") && r.request().method() !== "OPTIONS") {
      checkpointPayloads.push(await r.text().catch(() => ""));
    }
  };
  page.on("response", capture);

  await page.getByTestId("choose-study").click();
  await page.getByTestId("start-review").click(); // Check myself now
  await expect(page.getByTestId("session-mode")).toHaveText("Quick check");
  await expect(page.getByText("Answer without hints or notes")).toBeVisible();

  // 2. Explanation question: correct demo example. Only "Answer saved".
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S4-A");
  await page.getByTestId("demo-example-correct").click();
  await page.getByTestId("submit-answer").click();
  await expect(page.getByText("Answer saved.")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveCount(0);

  // 3. Calculation question: sign error.
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S5-A");
  await page.getByTestId("demo-example-wrong").click();
  const lastAnswer = page.waitForResponse((r) => r.url().includes("/answers") && r.request().method() === "POST");
  await page.getByTestId("submit-answer").click();
  await lastAnswer;
  page.off("response", capture);
  for (const body of checkpointPayloads) {
    expect(body).not.toMatch(/briefReason|referenceSummary|rubric|reference_json|0\.22314355|ANTHROPIC/);
  }

  // Feedback is released on its own once both answers are assessed.
  await expect(page.getByTestId("results-summary")).toHaveText("You explained Binary cross-entropy on your own. The calculation missed a step.");
  await expect(page.getByTestId("result-S4")).toContainText("Checked");
  await expect(page.getByTestId("result-S5")).toContainText("Learning");
  await expect(page.getByTestId("result-S5")).toContainText("Application needs another check");

  // 4. Only the missed question is offered for correction; help, then a correction that counts as practice.
  await expect(page.getByTestId("next-action")).toHaveText("Practise calculation");
  await page.getByTestId("next-action").click();
  await expect(page.locator('section[id^="question-"]')).toHaveCount(1);
  const repair = page.locator('section[id^="question-"]:has([data-question-id="S5-A"])');
  await expect(repair.getByTestId("correction-prompt")).toContainText("Fix the gap");
  await repair.getByTestId("get-help").click();
  await repair.getByTestId("reveal-hint").click();
  await expect(repair.getByTestId("help-content")).toContainText("identify which term remains");
  await repair.getByTestId("demo-example-correct").click();
  await repair.getByTestId("submit-answer").click();
  await expect(repair.getByTestId("attempt-repair")).toContainText("counts as practice");
  await expect(repair.getByTestId("attempt-original")).toContainText("BCE = ln(0.8)");
  // Fixed: the answer form is gone.
  await expect(repair.getByTestId("answer-input")).toHaveCount(0);
  await expect(page.getByTestId("results-summary")).toHaveText(
    "You explained Binary cross-entropy on your own. Calculation fixed with help. A fresh no-help check is scheduled.",
  );
  await expect(page.getByTestId("result-S5")).toContainText("Practised");
  await expect(page.getByTestId("result-due-S5")).toContainText("tomorrow");

  // 5. Return to overview: module levels and a future fresh check, outside today's plan.
  await page.getByTestId("next-action").click();
  await expect(page).toHaveURL("http://127.0.0.1:3100/");
  await expect(page.getByTestId("course-demo-course")).toContainText("1 of 6 subtopics checked on your own");
  // The just-corrected check is not offered again today.
  await expect(page.getByTestId("plan-row").filter({ hasText: "Review" })).toHaveCount(0);

  // Persistence across refresh.
  await page.reload();
  await expect(page.getByTestId("course-demo-course")).toContainText("1 of 6 subtopics checked on your own");

  // Topic page: subtopic levels, unassessed derivation, help recorded in history.
  await page.goto("/topics/demo-topic-bce");
  await expect(page.getByTestId("subtopic-U4")).toContainText("Checked");
  await expect(page.getByTestId("subtopic-U5")).toContainText("Practised");
  await expect(page.getByTestId("subtopic-U6")).toContainText("Not started");
  await page.getByText("Answer history").click();
  await expect(page.getByTestId("evidence-list")).toContainText("Hint shown");
  await expect(page.getByTestId("evidence-list")).toContainText("Correction (practice)");

  // Labelled historical example.
  await page.getByTestId("open-replay").click();
  await expect(page.getByTestId("replay-panel")).toContainText("Seeded example — not participant data");
});
