import { expect, test } from "@playwright/test";

// Runs last on the main server: Continue plans from whatever the earlier specs left, so this follows the plan generically.
test("Continue runs the planned steps in order: explanation first, correction above the box, summary of level changes", async ({ page }) => {
  await page.goto("/");
  // The dial sets the session length in five-minute steps; the plan follows it.
  const dial = page.getByTestId("session-dial");
  await expect(dial).toHaveAttribute("aria-valuenow", "25");
  await dial.focus();
  await page.keyboard.press("ArrowDown");
  await expect(dial).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("Home");
  await expect(dial).toHaveAttribute("aria-valuenow", "5");
  await expect(page.getByTestId("plan-row")).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(dial).toHaveAttribute("aria-valuenow", "60");
  await expect(page.getByTestId("plan-row").first()).toContainText("Learn");
  await expect(page.getByTestId("plan-scope")).toContainText(/Planning (from your module|across all \d+ modules)/);
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("run-stepper")).toContainText("step 1 of");
  await expect(page.getByTestId("session-mode")).toHaveText("Learn");
  // Learning explains first, without a click.
  await expect(page.getByTestId("explanation")).toBeVisible();

  // A partial answer puts the correction prompt directly above the answer box.
  await page.getByTestId("demo-example-partial").click();
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("correction-prompt")).toContainText("Still needed");
  await expect(page.getByLabel("Your correction")).toBeVisible();
  await page.getByTestId("demo-example-correct").click();
  await page.getByTestId("submit-answer").click();
  // Met: an outcome instead of another empty answer box.
  await expect(page.getByTestId("step-outcome")).toContainText("All essential criteria met");
  await expect(page.getByTestId("answer-input")).toHaveCount(0);

  // Work through any remaining practice questions in this step.
  for (;;) {
    await page.getByTestId("next-question").click();
    const done = page.getByTestId("step-outcome").filter({ hasText: "Practice done" });
    const next = page.getByTestId("demo-example-correct");
    await expect(done.or(next)).toBeVisible();
    if (await done.isVisible()) break;
    await next.click();
    await page.getByTestId("submit-answer").click();
  }
  await expect(page.getByTestId("run-footer")).toContainText(/Next step|Finish session/);
  await page.getByTestId("next-step").click();

  // Either the next step or, for a one-step plan, the summary.
  const summary = page.getByRole("heading", { name: "Session complete" });
  if (!(await summary.isVisible())) {
    await expect(page.getByTestId("run-stepper")).toContainText("step 2 of");
    await page.getByTestId("end-session").click();
  }
  await expect(summary).toBeVisible();
  await expect(page.getByText("What changed")).toBeVisible();
  await expect(page.getByTestId(/^change-/).filter({ hasText: "Practised" }).first()).toBeVisible();
  await page.getByTestId("back-to-overview").click();
  await expect(page).toHaveURL("http://127.0.0.1:3100/");
});
