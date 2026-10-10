import { expect, test } from "@playwright/test";

test("mock showcase: independent definition pass, application failure, supported correction, scheduled review, persistence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("provider-badge")).toContainText("Offline demo");
  await expect(page.getByRole("heading", { name: "Recommended next" })).toBeVisible();
  // Session plan rows link to real topics.
  await page.getByRole("link", { name: /^Open Binary cross-entropy/ }).click();
  await expect(page.getByRole("heading", { name: "Binary cross-entropy", exact: true })).toBeVisible();

  await page.getByTestId("start-review").click();
  await expect(page.getByRole("heading", { name: "Independent review checkpoint" })).toBeVisible();

  // 1. Explanation question (S4-A): correct demo example.
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S4-A");
  await page.getByTestId("demo-example-correct").click();
  await page.getByTestId("submit-answer").click();
  await expect(page.getByText("Answer saved")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveCount(0); // no feedback between checkpoint questions

  // 2. Application question (S5-A): sign error.
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-question-id", "S5-A");
  await page.getByTestId("demo-example-wrong").click();
  await page.getByTestId("submit-answer").click();

  // 3. Results: capabilities recorded separately.
  await expect(page.getByTestId("result-S4")).toContainText("Demonstrated independently");
  await expect(page.getByTestId("result-S5")).toContainText("Still developing");
  await expect(page.getByTestId("result-S5")).toContainText("Application needs another check");

  // 4. Release feedback, then hint + supported correction.
  await page.getByTestId("release-feedback").click();
  await expect(page.getByTestId("feedback").first()).toBeVisible();
  const s5 = page.locator('[data-question-id="S5-A"]').locator("xpath=ancestor::section[1]");
  await s5.getByTestId("reveal-hint").click();
  await expect(s5.getByTestId("help-content")).toContainText("Hint 1");
  await s5.getByTestId("demo-example-correct").click();
  await s5.getByTestId("submit-answer").click();
  await expect(s5.getByTestId("attempt-repair")).toContainText("supported");
  await expect(s5.getByTestId("attempt-repair")).toContainText("All essential criteria met");
  await expect(page.getByTestId("result-S5")).toContainText("Completed with support");
  await expect(page.getByTestId("result-due-S5")).toContainText("Review due tomorrow");

  // 5. Persistence across refresh, and the topic page shows separate evidence and the scheduled review.
  await page.reload();
  await expect(page.getByTestId("result-S5")).toContainText("Completed with support");
  await page.getByRole("link", { name: "← Binary cross-entropy" }).click();
  await expect(page.getByTestId("skill-S4")).toContainText("Demonstrated independently");
  await expect(page.getByTestId("skill-S5")).toContainText("Completed with support");
  await expect(page.getByTestId("skill-S5")).toContainText("Application needs another check");
  await expect(page.getByTestId("due-S5")).toHaveText("Review due tomorrow");
  await expect(page.getByTestId("skill-S6")).toContainText("Not checked yet");
  await expect(page.getByTestId("evidence-list").locator("li")).toHaveCount(3);

  // 6. Labelled historical replay with a distinct later question family.
  await page.getByTestId("open-replay").click();
  await expect(page.getByTestId("replay-panel")).toContainText("Seeded example — not participant data");
  await expect(page.getByTestId("replay-panel")).toContainText("S5-B");
});
