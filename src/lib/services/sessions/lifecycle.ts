// Sessions: ending a session and advancing a learning session.
import { listSessionQuestions, updateSession } from "../../db/repo";
import type { AppContext } from "../context";
import { AppError } from "../errors";
import { requireSession } from "./helpers";

// ---------------------------------------------------------------- end / advance

export function endSession(ctx: AppContext, sessionId: string, scope: "checkpoint" | "session" = "session") {
  ctx.db.transaction(() => {
    const session = requireSession(ctx, sessionId);
    if (session.status === "ended") return;
    if (session.mode === "review" && session.phase === "checkpoint") {
      // Unanswered questions remain unassessed; completed attempts stay valid.
      ctx.db
        .prepare(
          "UPDATE session_questions SET skipped = 1 WHERE session_id = ? AND id NOT IN (SELECT session_question_id FROM attempts WHERE phase = 'original')",
        )
        .run(sessionId);
      updateSession(ctx.db, sessionId, { phase: "results" });
    }
    if (scope === "session") updateSession(ctx.db, sessionId, { status: "ended", endedAt: ctx.clock.now() });
  })();
}

export function advanceLearning(ctx: AppContext, sessionId: string) {
  ctx.db.transaction(() => {
    const session = requireSession(ctx, sessionId);
    if (session.mode !== "learn" || session.status !== "active") throw new AppError("stale_phase", "Not an active learning session.");
    const total = listSessionQuestions(ctx.db, sessionId).length;
    if (session.currentOrdinal >= total) throw new AppError("stale_phase", "No further practice questions.");
    updateSession(ctx.db, sessionId, { currentOrdinal: session.currentOrdinal + 1 });
  })();
}

/** Demo example answers are offered only in offline mock mode and are labelled as such. */
export function demoExamplesFor(ctx: AppContext, questionId: string) {
  if (ctx.providerStatus.mode !== "mock") return [];
  const row = ctx.db.prepare("SELECT examples_json FROM questions WHERE id = ?").get(questionId) as
    | { examples_json: string }
    | undefined;
  if (!row) return [];
  return (JSON.parse(row.examples_json) as { label: string; answer: string }[]).map((e) => ({ label: e.label, answer: e.answer }));
}
