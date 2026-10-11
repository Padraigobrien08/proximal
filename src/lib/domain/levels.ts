// Mastery levels: learner-facing names for evidence states, rolled up Subtopic → Topic → Module. Pure and client-safe.
// A level is never averaged into a percentage: rollups count how many subtopics sit at each level.
import type { EvidenceState } from "./types";

export type Level = 0 | 1 | 2 | 3 | 4;

export const LEVEL_OF_STATE: Record<EvidenceState, Level> = {
  unassessed: 0,
  developing: 1,
  supported: 2,
  demonstrated_once: 3,
  retention_demonstrated: 4,
};

export const LEVELS: readonly { name: string; meaning: string }[] = [
  { name: "Not started", meaning: "Nothing attempted yet. This is not a failure." },
  { name: "Learning", meaning: "Attempted, but not yet right. Normal while learning." },
  { name: "Practised", meaning: "Right with help available: an explanation, hint, feedback or correction." },
  { name: "Checked", meaning: "Right on your own, with no help, once." },
  {
    name: "Secure",
    meaning: "Right on your own again, at least a day later, on a different kind of question. Describes what you've shown, not permanent mastery.",
  },
];

/** Level at which a subtopic counts as checked on your own. */
export const CHECKED: Level = 3;

export function levelOf(state: EvidenceState): Level {
  return LEVEL_OF_STATE[state];
}

/** A subtopic is as strong as its weakest required skill (all skills when none are required). */
export function subtopicLevel(skills: { required: boolean; evidenceState: EvidenceState }[]): Level {
  const counted = skills.some((s) => s.required) ? skills.filter((s) => s.required) : skills;
  if (counted.length === 0) return 0;
  return Math.min(...counted.map((s) => levelOf(s.evidenceState))) as Level;
}

export interface LevelRollup {
  /** Subtopics at each level, indexed 0..4. */
  counts: [number, number, number, number, number];
  total: number;
  /** Subtopics at Checked or Secure. */
  checked: number;
  /** Subtopics with a review due now. */
  due: number;
}

export function rollup(subtopics: { level: Level; due: boolean }[]): LevelRollup {
  const counts: LevelRollup["counts"] = [0, 0, 0, 0, 0];
  for (const s of subtopics) counts[s.level] += 1;
  return {
    counts,
    total: subtopics.length,
    checked: counts[3] + counts[4],
    due: subtopics.filter((s) => s.due).length,
  };
}

export function emptyRollup(): LevelRollup {
  return rollup([]);
}
