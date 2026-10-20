import { expect, test, type Locator, type Page } from "@playwright/test";

// AC14: a quick check can be done with the keyboard alone, every stop shows a focus indicator, dialogs return focus,
// and the plain-text view of a question has no TeX left in it. Runs on the objective topic, which other specs leave alone.

/** Press Tab until `target` has focus, checking that every stop on the way shows a visible focus indicator. */
async function tabTo(page: Page, target: Locator) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
      return { ring, name: (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.tagName).trim().slice(0, 60) };
    });
    if (stop) expect(stop.ring, `focus indicator on "${stop.name}"`).toBe(true);
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
  }
  throw new Error(`Not reachable with Tab: ${target}`);
}

async function activate(page: Page, target: Locator, key = "Enter") {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

test("keyboard only: reach a topic, take a quick check, use help and plain text, and close dialogs with focus returned", async ({ page }) => {
  await page.goto("/");
  await activate(page, page.getByRole("link", { name: "AI classification demo" }).first());
  await expect(page).toHaveURL(/\/courses\//);
  await activate(page, page.getByTestId("topic-row-demo-topic-objective"));
  await expect(page).toHaveURL(/\/topics\/demo-topic-objective/);
  await activate(page, page.getByTestId("choose-study"));
  await activate(page, page.getByTestId("start-review"));
  await expect(page).toHaveURL(/\/sessions\//);
  await expect(page.getByTestId("question-card")).toBeVisible();

  // Help opens and closes from the keyboard.
  await activate(page, page.getByTestId("get-help"));
  await expect(page.getByTestId("get-help")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("reveal-hint")).toBeVisible();
  await activate(page, page.getByTestId("get-help"));
  await expect(page.getByTestId("get-help")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("reveal-hint")).toBeHidden();

  // Answer with the keyboard: type into the box, then submit.
  await tabTo(page, page.getByTestId("answer-input"));
  await page.keyboard.type("Maximising the likelihood and minimising the negative log-likelihood give the same parameters.");
  await expect(page.getByTestId("answer-input")).not.toHaveValue("");
  await activate(page, page.getByTestId("demo-example-correct"));
  await activate(page, page.getByTestId("submit-answer"));
  await expect(page.getByTestId("submit-answer")).toHaveCount(0);

  // Feedback is released automatically once grading finishes.
  const feedback = page.locator("summary", { hasText: "Feedback on your answer" }).first();
  await expect(feedback).toBeVisible();

  // Flag dialog (inside the collapsed feedback): focus moves in, Escape closes it, focus returns to the trigger.
  await activate(page, feedback);
  const flag = page.getByRole("button", { name: "Flag judgement" }).first();
  await expect(flag).toBeVisible();
  await activate(page, flag);
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(flag).toBeFocused();

  // Chat drawer: focus moves to the input, Escape closes it, focus returns to the trigger.
  await page.goto("/topics/demo-topic-objective");
  await activate(page, page.getByTestId("open-chat"));
  await expect(page.getByTestId("chat-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-drawer")).toBeHidden();
  await expect(page.getByTestId("open-chat")).toBeFocused();
});

test("plain-text view of a maths question has no TeX and keeps exponent grouping", async ({ page }) => {
  // The S6 questions carry the hardest notation (p^y(1-p)^{1-y}, \sum_k t_k \log p_k). The topic page has no
  // per-skill start, so start the check through the app's own API from the page, then use the keyboard.
  await page.goto("/topics/demo-topic-bce");
  const sessionId = await page.evaluate(async () => {
    const r = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicId: "demo-topic-bce", mode: "review", skillIds: ["S6"] }),
    });
    return ((await r.json()) as { data: { sessionId: string } }).data.sessionId;
  });
  await page.goto(`/sessions/${sessionId}`);
  const card = page.getByTestId("question-card");
  await expect(card).toHaveAttribute("data-question-id", /^S6-/);
  const questionId = await card.getAttribute("data-question-id");

  // Screen-reader text sits beside the hidden KaTeX output.
  const spoken = await page.getByTestId("question-prompt").locator(".sr-only").allInnerTexts();
  expect(spoken.length).toBeGreaterThan(0);
  for (const s of spoken) expect(s).not.toMatch(/[$\\{}]/);

  await activate(page, page.getByRole("button", { name: "Show plain text" }));
  const plain = await page.getByTestId("question-prompt").innerText();
  expect(plain).not.toMatch(/[$\\{}]/);
  expect(plain).toContain(questionId === "S6-A" ? "p^y(1-p)^(1-y)" : "Σ_k t_k log p_k");
  await activate(page, page.getByRole("button", { name: "Show formatted maths" }));
  await expect(page.getByTestId("question-prompt").locator(".katex").first()).toBeVisible();
});
