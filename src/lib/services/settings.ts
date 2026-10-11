// Learner preferences for planning. Stored server-side because the plan is built on the server.
import { z } from "zod";
import { listCourses } from "../db/repo";
import type { AppContext } from "./context";
import { AppError } from "./errors";

/** Session length range for the dial, in minutes. */
export const SESSION_MINUTES = { min: 5, max: 60, step: 5, default: 25 } as const;

export function clampSessionMinutes(value: number): number {
  if (!Number.isFinite(value)) return SESSION_MINUTES.default;
  const stepped = Math.round(value / SESSION_MINUTES.step) * SESSION_MINUTES.step;
  return Math.min(SESSION_MINUTES.max, Math.max(SESSION_MINUTES.min, stepped));
}

const studyPlanSchema = z.strictObject({
  /** all: Continue plans across every approved module (new modules included automatically). chosen: only moduleIds. */
  modules: z.enum(["all", "chosen"]),
  moduleIds: z.array(z.string().min(1)).max(200),
});

export type StudyPlanSettings = z.infer<typeof studyPlanSchema>;

const DEFAULT_PLAN: StudyPlanSettings = { modules: "all", moduleIds: [] };

export function getStudyPlanSettings(ctx: Pick<AppContext, "db">): StudyPlanSettings {
  const row = ctx.db.prepare("SELECT value_json FROM settings WHERE key = 'study_plan'").get() as { value_json: string } | undefined;
  if (!row) return DEFAULT_PLAN;
  const parsed = studyPlanSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT_PLAN;
}

export function setStudyPlanSettings(ctx: Pick<AppContext, "db" | "clock">, input: unknown): StudyPlanSettings {
  const value = studyPlanSchema.parse(input);
  const known = new Set(listCourses(ctx.db).map((c) => c.id));
  const moduleIds = [...new Set(value.moduleIds)].filter((id) => known.has(id));
  if (value.modules === "chosen" && moduleIds.length === 0) {
    throw new AppError("validation", "Choose at least one module, or plan across all modules.");
  }
  const saved = { modules: value.modules, moduleIds };
  ctx.db
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('study_plan', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    )
    .run(JSON.stringify(saved), ctx.clock.now());
  return saved;
}

/** Module ids the overall plan may draw from, or null for every approved module. */
export function plannedModuleIds(ctx: Pick<AppContext, "db">): Set<string> | null {
  const s = getStudyPlanSettings(ctx);
  return s.modules === "chosen" ? new Set(s.moduleIds) : null;
}
