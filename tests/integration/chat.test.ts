import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMockProvider } from "../../src/lib/llm/factory";
import type { ChatInput } from "../../src/lib/llm/types";
import { askChat, CHAT_HELP_WINDOW_MS, getChatView, startNewThread } from "../../src/lib/services/chat";
import { getSessionView, releaseCheckpointFeedback, startSession, submitAnswer } from "../../src/lib/services/sessions";
import { createTestContext, exampleAnswer } from "../helpers";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const meta = { mode: "live" as const, vendor: "openai" as const, model: "m", promptVersion: "chat-v1", usage: null };

/** A live-like chat that cites its first page and records what it was shown. */
async function setup(reply: Partial<{ citedRefs: number[]; coveredBySources: boolean }> = {}) {
  const seen: ChatInput[] = [];
  const t = await createTestContext({
    provider: (db) =>
      Object.assign(createMockProvider(db), {
        chat: async (input: ChatInput) => {
          seen.push(input);
          return { reply: { answer: "BCE penalises confident wrong predictions [ref 1].", citedRefs: [1, 99], coveredBySources: true, ...reply }, meta };
        },
      }),
  });
  cleanup = t.cleanup;
  return { ...t, seen };
}

async function checkS4(ctx: Awaited<ReturnType<typeof setup>>["ctx"]) {
  const { sessionId } = startSession(ctx, { topicId: "demo-topic-bce", purpose: "check", skillIds: ["S4"] });
  const sq = getSessionView(ctx, sessionId).current!;
  await submitAnswer(ctx, sessionId, { sessionQuestionId: sq.sessionQuestionId, submissionKey: randomUUID(), answer: exampleAnswer(sq.question.id, "correct") });
  releaseCheckpointFeedback(ctx, sessionId);
  return getSessionView(ctx, sessionId).results!.skills[0];
}

describe("Ask your lectures", () => {
  it("answers from retrieved pages, keeps only citations of pages it was shown, and saves the conversation", async () => {
    const { ctx, seen } = await setup();
    const res = await askChat(ctx, "demo-course", { question: "How is binary cross-entropy different from accuracy?" });
    expect(seen[0].pages.length).toBeGreaterThan(0);
    expect(seen[0].pages[0].text.toLowerCase()).toContain("accuracy");
    const answer = res.messages[1];
    expect(answer).toMatchObject({ role: "assistant", origin: "live", covered: true });
    // ref 99 was never provided and is dropped.
    expect(answer.citations).toEqual([{ sourceId: expect.any(String), sourceLabel: expect.any(String), page: seen[0].pages[0].page }]);

    await askChat(ctx, "demo-course", { question: "Why?", threadId: res.threadId });
    expect(seen[1].history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(getChatView(ctx, "demo-course").messages).toHaveLength(4);

    const fresh = startNewThread(ctx, "demo-course");
    expect(getChatView(ctx, "demo-course")).toMatchObject({ threadId: fresh, messages: [] });
  });

  it("offline mode shows the best-matching pages instead of an AI answer", async () => {
    const t = await createTestContext();
    cleanup = t.cleanup;
    const res = await askChat(t.ctx, "demo-course", { question: "What does binary cross-entropy penalise?" });
    expect(res.messages[1]).toMatchObject({ origin: "offline" });
    expect(res.messages[1].citations.length).toBeGreaterThan(0);
  });

  it("chat about a subtopic shortly before a no-help check makes that answer count as practice", async () => {
    const { ctx, clock } = await setup();
    await askChat(ctx, "demo-course", { question: "How is binary cross-entropy different from accuracy?" });
    const result = await checkS4(ctx);
    expect(result.originalOutcome).toBe("pass");
    expect(result.originalIndependent).toBe(false);
    expect(result.evidenceState).toBe("supported");

    // Outside the window, a later check counts again.
    clock.advance(CHAT_HELP_WINDOW_MS + 24 * 60 * 60 * 1000);
    const later = await checkS4(ctx);
    expect(later.originalIndependent).toBe(true);
  });

  it("chat during an open check is recorded as help for that check", async () => {
    const { ctx } = await setup();
    const { sessionId } = startSession(ctx, { topicId: "demo-topic-bce", purpose: "check", skillIds: ["S4"] });
    await askChat(ctx, "demo-course", { question: "How is binary cross-entropy different from accuracy?" });
    const view = getSessionView(ctx, sessionId);
    expect(view.current!.recentChatHelp).toBe(true);
    const sq = view.current!;
    await submitAnswer(ctx, sessionId, { sessionQuestionId: sq.sessionQuestionId, submissionKey: randomUUID(), answer: exampleAnswer(sq.question.id, "correct") });
    releaseCheckpointFeedback(ctx, sessionId);
    expect(getSessionView(ctx, sessionId).results!.skills[0].originalIndependent).toBe(false);
  });

  it("labels an answer the lectures don't cover", async () => {
    const { ctx } = await setup({ citedRefs: [], coveredBySources: false });
    const res = await askChat(ctx, "demo-course", { question: "Who invented the transformer architecture?" });
    expect(res.messages[1]).toMatchObject({ covered: false, citations: [] });
  });
});
