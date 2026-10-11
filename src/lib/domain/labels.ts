// Learner-facing wording. Pure and client-safe.
import { LEVELS } from "./levels";
import { MS_DAY, type EvidenceState, type TaskType } from "./types";

/** Evidence states use the mastery level names (see levels.ts) so every screen shares one vocabulary. */
export const EVIDENCE_LABELS: Record<EvidenceState, { label: string; explanation: string; tone: "neutral" | "info" | "good" | "warn" }> = {
  unassessed: { label: LEVELS[0].name, explanation: LEVELS[0].meaning, tone: "neutral" },
  developing: {
    label: LEVELS[1].name,
    explanation: "The last answer that counted missed a step. That is normal while learning; another check is scheduled.",
    tone: "warn",
  },
  supported: {
    label: LEVELS[2].name,
    explanation: "Right after an explanation, hint, notes or feedback. Useful practice; a no-help check is still needed to reach Checked.",
    tone: "info",
  },
  demonstrated_once: {
    label: LEVELS[3].name,
    explanation: "One first answer met every essential criterion with no help. A later check on a different question is needed to reach Secure.",
    tone: "good",
  },
  retention_demonstrated: {
    label: LEVELS[4].name,
    explanation:
      "No-help passes at least 24 hours apart, in different sessions and question types, including a new-context question. This describes what you've shown, not permanent mastery.",
    tone: "good",
  },
};

export function isApplicationTask(t: TaskType): boolean {
  return t === "calculate" || t === "apply";
}

/** Calendar-day difference in the display timezone (wording only; scheduling uses elapsed time). */
function calendarDayDiff(from: number, to: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const a = Date.parse(`${fmt.format(new Date(from))}T00:00:00Z`);
  const b = Date.parse(`${fmt.format(new Date(to))}T00:00:00Z`);
  return Math.round((b - a) / MS_DAY);
}

export function formatDateTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function dueLabel(dueAt: number | null, now: number, timeZone: string): string {
  if (dueAt === null) return "No review scheduled";
  if (dueAt <= now) {
    const days = calendarDayDiff(dueAt, now, timeZone);
    return days >= 1 ? `Review overdue since ${formatDateTime(dueAt, timeZone)}` : "Review due now";
  }
  const days = calendarDayDiff(now, dueAt, timeZone);
  if (days === 0) return `Review due later today (${formatDateTime(dueAt, timeZone)})`;
  if (days === 1) return "Review due tomorrow";
  return `Review due in ${days} days`;
}

export type Freshness = "scheduled" | "due" | "overdue" | "reassessment_needed";

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  scheduled: "Scheduled",
  due: "Due today",
  overdue: "Overdue",
  reassessment_needed: "Needs another check",
};

/** Freshness is separate from evidence: being due never erases past independent evidence. */
export function freshnessOf(dueAt: number | null, reassessmentNeeded: boolean, now: number, timeZone: string): Freshness | null {
  if (dueAt === null) return null;
  if (reassessmentNeeded) return "reassessment_needed";
  if (dueAt > now) return "scheduled";
  return calendarDayDiff(dueAt, now, timeZone) >= 1 ? "overdue" : "due";
}

/** "Tomorrow, 19:10" style wording based on actual local dates; exact date/time otherwise. */
export function relativeWhen(at: number, now: number, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  const diff = calendarDayDiff(now, at, timeZone);
  if (diff === 0) return `today at ${time}`;
  if (diff === 1) return `tomorrow at ${time}`;
  if (diff === -1) return `yesterday at ${time}`;
  return formatDateTime(at, timeZone);
}

const VENDOR_NAMES: Record<string, string> = { anthropic: "Claude", openai: "OpenAI" };

/** Display name for a live provider vendor ("Claude", "OpenAI"); unknown or missing vendors read "AI". */
export function vendorName(vendor: string | null | undefined): string {
  return (vendor && VENDOR_NAMES[vendor]) || "AI";
}

/**
 * Who judged an answer, from a stored provider model ("openai:gpt-x", "anthropic:claude-x").
 * Older rows without a vendor prefix were produced by the Claude adapter.
 */
export function judgedByLabel(providerModel: string | null): string {
  if (!providerModel) return "Judged by the configured AI provider";
  const i = providerModel.indexOf(":");
  const [vendor, model] = i > 0 ? [providerModel.slice(0, i), providerModel.slice(i + 1)] : ["anthropic", providerModel];
  return `Judged by ${vendorName(vendor)} (${model})`;
}
