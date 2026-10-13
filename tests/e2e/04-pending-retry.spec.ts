import { expect, test } from "@playwright/test";

// Runs against the fault-injection server: its first offline assessment fails like a provider outage.
test.use({ baseURL: "http://127.0.0.1:3101" });

test("a failed assessment stays saved and pending, offers an explicit retry, and never becomes a pass by itself", async ({ page }) => {
  await page.goto("/topics/demo-topic-bce");
  await page.getByTestId("choose-study").click();
  await page.getByTestId("start-review").click();
  await page.getByTestId("demo-example-correct").click();
  await page.getByTestId("submit-answer").click();
  // Check answers are graded in the background: saving never waits for the provider.
  await expect(page.getByText("Answer saved.")).toBeVisible();
  await page.getByTestId("demo-example-wrong").click();
  await page.getByTestId("submit-answer").click();

  await expect(page.getByTestId("result-S4")).toContainText("Answer saved · assessment pending");
  await expect(page.getByTestId("results-grading")).toContainText("didn't complete");
  await expect(page.getByTestId("result-S4")).toContainText("Not started");
  await expect(page.getByTestId("release-feedback")).toHaveCount(0);

  // Resume from a refresh keeps the pending state; nothing is re-assessed automatically.
  await page.reload();
  await expect(page.getByTestId("result-S4")).toContainText("Answer saved · assessment pending");

  await page.getByTestId("retry-assessment").click();
  await expect(page.getByTestId("result-S4")).toContainText("Checked");
  // Once everything is assessed, feedback is released without another click.
  await expect(page.getByTestId("results-summary")).toContainText("You explained Binary cross-entropy on your own.");
});
