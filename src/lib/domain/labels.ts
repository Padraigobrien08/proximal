// Learner-facing wording. Pure and client-safe.
import { MS_DAY, type EvidenceState, type TaskType } from "./types";

export const EVIDENCE_LABELS: Record<EvidenceState, { label: string; explanation: string; tone: "neutral" | "info" | "good" | "warn" }> = {
  unassessed: {
    label: "Not checked yet",
    explanation: "No usable answer has been recorded for this skill yet.",
    tone: "neutral",
  },
  developing: {
    label: "Still developing",
    explanation:
      "Answers so far were incomplete or incorrect. That is normal while learning; another attempt is scheduled.",
    tone: "warn",
  },
  supported: {
    label: "Completed with support",
    explanation:
      "You met the criteria after help (a hint, source, feedback, explanation or learning mode). This is useful practice but not independent evidence.",
    tone: "info",
  },
  demonstrated_once: {
    label: "Demonstrated independently",
    explanation:
      "One review answer met every essential criterion without help. A later check in a different context is needed before retention is recorded.",
    tone: "good",
  },
  retention_demonstrated: {
    label: "Retained across reviews",
    explanation:
      "Two independent passes at least 24 hours apart, in different sessions and question families, including a new-context question. This describes observed performance, not permanent mastery.",
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
