import { expect, test, type Response } from "@playwright/test";

test("P0 showcase: independent explanation, calculation gap, supported repair, scheduled fresh check, persistence", async ({ page }) => {
  // U01: a new workspace shows a real starting action and real counts, no invented progress.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your study workspace" })).toBeVisible();
  await expect(page.getByTestId("provider-badge")).toContainText("Offline demo · supplied examples only.");
  await expect(page.getByTestId("recommendation")).toContainText("Start learning");
  await expect(page.getByTestId("recommendation").getByRole("heading")).toHaveText("Model and likelihood");
  await expect(page.getByTestId("recommendation")).toContainText("Interpret the model notation, then write a dataset likelihood.");
  await expect(page.getByTestId("plan-row").first()).toContainText("Notation and dataset likelihood · not studied yet");
  await expect(page.getByTestId("course-demo-course")).toContainText("0 of 6 required skills checked independently");
  await expect(page.getByRole("heading", { name: "Recent evidence" })).toHaveCount(0);

  // The showcase enters BCE through its topic page (the queue is not rigged).
  await page.getByRole("link", { name: "AI classification demo" }).first().click();
  await page.getByRole("link", { name: "Open topic" }).nth(2).click();
  await expect(page.getByRole("heading", { name: "Binary cross-entropy", exact: true })).toBeVisible();

  // U03: record every API payload while the checkpoint is open.
  const checkpointPayloads: string[] = [];
  const capture = async (r: Response) => {
    if (r.url().includes("/api/") && r.request().method() !== "OPTIONS") {
      checkpointPayloads.push(await r.text().catch(() => ""));
    }
  };
  page.on("response", capture);

  await page.getByTestId("start-review").click(); // Check understanding
  await expect(page.getByTestId("session-mode")).toHaveText("Independent check");
  await expect(page.getByText("Answer without hints or notes for an independent check.")).toBeVisible();

  // 2. Explanation question: correct demo example. Only "Answer saved".
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S4-A");
  await page.getByTestId("demo-example-correct").click();
  await page.getByTestId("submit-answer").click();
  await expect(page.getByText("Answer saved.")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveCount(0);

  // 3. Calculation question: sign error.
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S5-A");
  await page.getByTestId("demo-example-wrong").click();
  await page.getByTestId("submit-answer").click();
  page.off("response", capture);
  for (const body of checkpointPayloads) {
    expect(body).not.toMatch(/briefReason|referenceSummary|rubric|reference_json|0\.22314355|ANTHROPIC/);
  }

  // Results lead in plain language; capabilities are recorded separately.
  await expect(page.getByTestId("results-summary")).toHaveText(
    "You explained Binary cross-entropy independently. The calculation needs practice.",
  );
  await expect(page.getByTestId("result-S4")).toContainText("Demonstrated independently");
  await expect(page.getByTestId("result-S5")).toContainText("Needs practice");
  await expect(page.getByTestId("result-S5")).toContainText("Application needs another check");

  // 4. Release feedback, use help, submit a supported correction.
  await page.getByTestId("release-feedback").click();
  await expect(page.getByTestId("next-action")).toHaveText("Practise calculation");
  await page.getByTestId("next-action").click();
  const repair = page.locator('section[id^="question-"]:has([data-question-id="S5-A"])');
  await repair.getByTestId("get-help").click();
  await repair.getByTestId("reveal-hint").click();
  await expect(repair.getByTestId("help-content")).toContainText("identify which term remains");
  await repair.getByTestId("demo-example-correct").click();
  await repair.getByTestId("submit-answer").click();
  await expect(repair.getByTestId("attempt-repair")).toContainText("supported");
  await expect(repair.getByTestId("attempt-original")).toContainText("BCE = ln(0.8)");
  await expect(page.getByTestId("results-summary")).toHaveText(
    "You explained Binary cross-entropy independently. Calculation completed with support. A fresh independent check is scheduled.",
  );
  await expect(page.getByTestId("result-S5")).toContainText("Completed with support");
  await expect(page.getByTestId("result-due-S5")).toContainText("tomorrow");

  // 5. Return to overview: current evidence and a future fresh check, outside today's plan.
  await page.getByTestId("next-action").click();
  await expect(page).toHaveURL("http://127.0.0.1:3100/");
  await expect(page.getByTestId("recent-S4")).toContainText("Explanation");
  await expect(page.getByTestId("recent-S4")).toContainText("Demonstrated independently");
  await expect(page.getByTestId("recent-S5")).toContainText("Calculation");
  await expect(page.getByTestId("recent-S5")).toContainText("Completed with support");
  // Both skills are scheduled 24h out: the explanation after its first independent pass, the calculation after its gap.
  await expect(page.getByTestId("upcoming-check")).toContainText("Fresh check");
  await expect(page.getByTestId("upcoming-check")).toContainText("BCE meaning and loss calculation");
  await expect(page.getByTestId("upcoming-check")).toContainText("Binary cross-entropy");
  await expect(page.getByTestId("upcoming-check")).toContainText("Scheduled tomorrow at");
  await expect(page.getByTestId("course-demo-course")).toContainText("1 of 6 required skills checked independently");
  // The just-repaired check is not offered again today.
  await expect(page.getByTestId("plan-row").filter({ hasText: "Review" })).toHaveCount(0);

  // Persistence across refresh.
  await page.reload();
  await expect(page.getByTestId("recent-S4")).toContainText("Demonstrated independently");
  await expect(page.getByTestId("recent-S5")).toContainText("Completed with support");
  await expect(page.getByTestId("upcoming-check")).toContainText("Scheduled tomorrow at");

  // Topic page: separate skill evidence, unassessed derivation, help recorded in history.
  await page.getByTestId("recent-S5").getByRole("link", { name: "Open topic" }).click();
  await expect(page.getByTestId("skill-S4")).toContainText("Demonstrated independently");
  await expect(page.getByTestId("skill-S5")).toContainText("Completed with support");
  await expect(page.getByTestId("skill-S6")).toContainText("Not checked yet");
  await expect(page.getByTestId("evidence-list")).toContainText("Hint shown");
  await expect(page.getByTestId("evidence-list")).toContainText("Supported correction");

  // Labelled historical example.
  await page.getByTestId("open-replay").click();
  await expect(page.getByTestId("replay-panel")).toContainText("Seeded example — not participant data");
});
