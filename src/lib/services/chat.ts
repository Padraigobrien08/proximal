// "Ask your lectures": module-scoped chat answered from the module's lecture pages, with page citations.
// Chat is help: during a session it is recorded like an explanation, and chat about a subtopic counts as help for
// checks on it within CHAT_HELP_WINDOW_MS (see recentChatHelp, used when an answer is submitted).
import { MS_HOUR } from "../domain/types";
import { rankBm25 } from "../domain/retrieval";
import { getCourse, insertExposure, listSkillsForTopic, listSourcePages, listSourcesForCourse, listTopics, newId } from "../db/repo";
import { MAX_CHAT_QUESTION_CHARS } from "../llm/schemas";
import { ProviderError, type ChatInput, type ChatReply } from "../llm/types";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";

/** Chat about a subtopic counts as help for no-help checks on it for this long. */
export const CHAT_HELP_WINDOW_MS = 3 * MS_HOUR;
const MAX_PAGES = 5;
const MAX_PAGE_CHARS = 3500;
const HISTORY_TURNS = 6;

export interface Citation {
  sourceId: string;
  sourceLabel: string;
  page: number;
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  covered: boolean;
  origin: "live" | "offline" | "error";
  createdAt: number;
}

interface PageDoc {
  sourceId: string;
  sourceLabel: string;
  page: number;
  text: string;
}

function requireCourse(ctx: AppContext, courseId: string) {
  const course = getCourse(ctx.db, courseId);
  if (!course) throw notFound("Module");
  return course;
}

function modulePages(ctx: AppContext, courseId: string): PageDoc[] {
  return listSourcesForCourse(ctx.db, courseId)
    .filter((s) => s.status === "extracted")
    .flatMap((s) =>
      listSourcePages(ctx.db, s.id)
        .filter((p) => p.text.trim().length > 0)
        .map((p) => ({ sourceId: s.id, sourceLabel: s.label ?? s.originalName, page: p.pageNumber, text: p.text })),
    );
}

function latestThreadId(ctx: AppContext, courseId: string): string | null {
  const row = ctx.db.prepare("SELECT id FROM chat_threads WHERE course_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1").get(courseId) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

function listMessages(ctx: AppContext, threadId: string): ChatMessageView[] {
  const rows = ctx.db
    .prepare("SELECT id, role, content, citations_json, covered, origin, created_at FROM chat_messages WHERE thread_id = ? ORDER BY created_at, rowid")
    .all(threadId) as { id: string; role: "user" | "assistant"; content: string; citations_json: string; covered: number; origin: ChatMessageView["origin"]; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    citations: JSON.parse(r.citations_json) as Citation[],
    covered: !!r.covered,
    origin: r.origin,
    createdAt: r.created_at,
  }));
}

function insertMessage(ctx: AppContext, threadId: string, m: Omit<ChatMessageView, "id">): ChatMessageView {
  const id = newId();
  ctx.db
    .prepare("INSERT INTO chat_messages (id, thread_id, role, content, citations_json, covered, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, threadId, m.role, m.content, JSON.stringify(m.citations), m.covered ? 1 : 0, m.origin, m.createdAt);
  ctx.db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(m.createdAt, threadId);
  return { id, ...m };
}

export function getChatView(ctx: AppContext, courseId: string) {
  const course = requireCourse(ctx, courseId);
  const threadId = latestThreadId(ctx, courseId);
  return {
    module: { id: course.id, title: course.title },
    threadId,
    messages: threadId ? listMessages(ctx, threadId) : [],
    pageCount: modulePages(ctx, courseId).length,
    mode: ctx.providerStatus.mode === "live" && ctx.providerStatus.ready ? ("live" as const) : ("offline" as const),
    helpWindowHours: CHAT_HELP_WINDOW_MS / MS_HOUR,
  };
}

export function startNewThread(ctx: AppContext, courseId: string): string {
  requireCourse(ctx, courseId);
  const id = newId();
  const now = ctx.clock.now();
  ctx.db.prepare("INSERT INTO chat_threads (id, course_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, courseId, now, now);
  return id;
}

/** Pages to show the model: best keyword matches for the question (and the previous question, for follow-ups). */
function retrieve(pages: PageDoc[], question: string, previousQuestion: string | null): PageDoc[] {
  const ranked = rankBm25(pages, (p) => p.text, question).map((r) => r.doc);
  const followUp = previousQuestion ? rankBm25(pages, (p) => p.text, previousQuestion).map((r) => r.doc) : [];
  const chosen: PageDoc[] = [];
  for (const p of [...ranked.slice(0, MAX_PAGES - 1), ...followUp.slice(0, 2), ...ranked.slice(MAX_PAGES - 1)]) {
    if (chosen.length >= MAX_PAGES) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  // Broad questions ("summarise this lecture") match little: give the opening pages for orientation.
  if (chosen.length < 2) for (const p of pages) if (chosen.length < 4 && !chosen.includes(p)) chosen.push(p);
  return chosen;
}

/** Skills whose subtopic cites one of these pages. */
function skillsForPages(ctx: AppContext, courseId: string, pages: { page: number }[]): string[] {
  const wanted = new Set(pages.map((p) => p.page));
  if (wanted.size === 0) return [];
  return listTopics(ctx.db, courseId)
    .flatMap((t) => listSkillsForTopic(ctx.db, t.id))
    .filter((s) => s.unit.sourceRefs.some((r) => wanted.has(r.page)))
    .map((s) => s.id);
}

export async function askChat(ctx: AppContext, courseId: string, input: { question: string; threadId?: string | null }) {
  const course = requireCourse(ctx, courseId);
  const question = input.question.trim();
  if (!question) throw new AppError("validation", "Type a question first.");
  if (question.length > MAX_CHAT_QUESTION_CHARS) throw new AppError("validation", `Questions are limited to ${MAX_CHAT_QUESTION_CHARS} characters.`);
  const pages = modulePages(ctx, courseId);
  if (pages.length === 0) throw new AppError("unavailable_reviewed_content", "This module has no extracted lecture text to answer from.");

  let threadId = input.threadId ?? latestThreadId(ctx, courseId);
  if (threadId) {
    const owner = ctx.db.prepare("SELECT course_id FROM chat_threads WHERE id = ?").get(threadId) as { course_id: string } | undefined;
    if (!owner || owner.course_id !== courseId) throw notFound("Conversation");
  } else {
    threadId = startNewThread(ctx, courseId);
  }

  const history = listMessages(ctx, threadId).filter((m) => m.origin !== "error");
  const previousQuestion = [...history].reverse().find((m) => m.role === "user")?.content ?? null;
  const userMessage = insertMessage(ctx, threadId, { role: "user", content: question, citations: [], covered: true, origin: "live", createdAt: ctx.clock.now() });

  const shown = retrieve(pages, question, previousQuestion);
  const chatInput: ChatInput = {
    moduleTitle: course.title,
    question,
    history: history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content.slice(0, 1500) })),
    pages: shown.map((p, i) => ({ ref: i + 1, sourceLabel: p.sourceLabel, page: p.page, text: p.text.slice(0, MAX_PAGE_CHARS) })),
  };

  let reply: ChatReply;
  let origin: ChatMessageView["origin"] = "live";
  try {
    if (!ctx.provider.chat) throw new ProviderError("No chat provider.", "offline_unsupported", false);
    reply = (await ctx.provider.chat(chatInput)).reply;
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.code === "offline_unsupported") {
      origin = "offline";
      reply = {
        answer: "AI chat isn't available in offline mode. These are the lecture pages that best match your question.",
        citedRefs: chatInput.pages.slice(0, 3).map((p) => p.ref),
        coveredBySources: true,
      };
    } else {
      const assistant = insertMessage(ctx, threadId, {
        role: "assistant",
        content: `The answer didn't come through: ${err.message}`,
        citations: [],
        covered: true,
        origin: "error",
        createdAt: ctx.clock.now(),
      });
      return { threadId, messages: [userMessage, assistant] };
    }
  }

  // Only pages actually provided can be cited.
  const cited = [...new Set(reply.citedRefs)]
    .map((ref) => shown[ref - 1])
    .filter((p): p is PageDoc => !!p)
    .sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel) || a.page - b.page);
  const now = ctx.clock.now();
  const assistant = insertMessage(ctx, threadId, {
    role: "assistant",
    content: reply.answer,
    citations: cited.map((p) => ({ sourceId: p.sourceId, sourceLabel: p.sourceLabel, page: p.page })),
    covered: reply.coveredBySources,
    origin,
    createdAt: now,
  });

  // Chat is help for the subtopics it drew on: recorded now in any open session for this module, and remembered for
  // later checks. A general answer drew on no pages, so the pages that were offered stand in.
  const skillIds = skillsForPages(ctx, courseId, cited.length > 0 ? cited : shown);
  ctx.db.transaction(() => {
    const touch = ctx.db.prepare("INSERT OR IGNORE INTO chat_skill_touches (message_id, skill_id, touched_at) VALUES (?, ?, ?)");
    for (const id of skillIds) touch.run(assistant.id, id, now);
    if (skillIds.length === 0) return;
    const open = ctx.db
      .prepare("SELECT s.id FROM sessions s JOIN topics t ON t.id = s.topic_id WHERE t.course_id = ? AND s.status = 'active'")
      .all(courseId) as { id: string }[];
    for (const s of open) {
      insertExposure(ctx.db, { sessionId: s.id, kind: "explanation", affectedSkillIds: skillIds, contentRef: `chat:${assistant.id}`, recordedAt: now });
    }
  })();

  return { threadId, messages: [userMessage, assistant] };
}

/** Of these skills, those the learner asked the chat about within the help window before `now`. */
export function recentChatHelp(ctx: Pick<AppContext, "db">, skillIds: string[], now: number): Set<string> {
  if (skillIds.length === 0) return new Set();
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT skill_id FROM chat_skill_touches WHERE touched_at > ? AND touched_at <= ? AND skill_id IN (${skillIds.map(() => "?").join(",")})`,
    )
    .all(now - CHAT_HELP_WINDOW_MS, now, ...skillIds) as { skill_id: string }[];
  return new Set(rows.map((r) => r.skill_id));
}
