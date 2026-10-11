import { expect, test } from "@playwright/test";

// Offline mock mode: chat answers with the best-matching lecture pages (no AI), linked to the PDF.
test("Ask your lectures opens from a topic, answers with page links, and keeps the conversation", async ({ page }) => {
  await page.goto("/topics/demo-topic-bce");
  await page.getByTestId("open-chat").first().click();
  const drawer = page.getByTestId("chat-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("chat-notice")).toContainText("Offline demo");

  await page.getByTestId("chat-input").fill("How is binary cross-entropy different from accuracy?");
  await page.keyboard.press("Enter");
  const answer = page.getByTestId("chat-answer").last();
  await expect(answer).toContainText("best match your question");
  const links = answer.getByTestId("chat-citations").getByRole("link");
  await expect(links.first()).toHaveAttribute("href", /\/api\/sources\/.+#page=\d+/);

  // Escape closes; reopening shows the saved conversation.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.getByTestId("open-chat").first().click();
  await expect(page.getByTestId("chat-answer")).toHaveCount(1);
});
