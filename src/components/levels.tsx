"use client";

// Shared mastery-level visuals. Colour is always paired with text: pills name the level, bars carry an accessible summary.
import { LEVELS, type Level, type LevelRollup } from "@/lib/domain/levels";

const FILL = ["bg-lv0", "bg-lv1", "bg-lv2", "bg-lv3", "bg-lv4"] as const;
const PILL = [
  "bg-line/60 text-muted",
  "bg-amber-soft text-amber-ink",
  "bg-sky-soft text-sky-ink",
  "bg-green-soft text-green-ink",
  "bg-teal text-white",
] as const;

export function LevelPill({ level }: { level: Level }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${PILL[level]}`} data-testid="level-pill">
      {LEVELS[level].name}
    </span>
  );
}

export function DuePill() {
  return <span className="inline-flex items-center whitespace-nowrap rounded-md bg-amber-soft px-2 py-0.5 text-xs font-medium text-amber-ink">Review due</span>;
}

/** Four steps above Not started, filled up to the current level. */
export function LevelLadder({ level }: { level: Level }) {
  return (
    <span className="flex gap-[3px]" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={`h-1.5 w-[18px] rounded-sm ${i <= level ? FILL[level] : "bg-lv0"}`} />
      ))}
    </span>
  );
}

export function rollupSentence(r: LevelRollup): string {
  const parts = r.counts.map((n, lv) => (n ? `${n} ${LEVELS[lv].name}` : null)).filter(Boolean);
  return `${r.checked} of ${r.total} subtopics checked on your own${parts.length ? ` (${parts.join(", ")})` : ""}${r.due ? `, ${r.due} due for review` : ""}.`;
}

/** One segment per subtopic, strongest first; due subtopics get an outline. */
export function LevelBar({ subtopics, size = "md", label }: { subtopics: { level: Level; due: boolean }[]; size?: "sm" | "md"; label?: string }) {
  const sorted = [...subtopics].sort((a, b) => b.level - a.level);
  return (
    <div className={`flex ${size === "sm" ? "h-[5px] gap-0.5" : "h-2.5 gap-[3px]"}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {sorted.length === 0 && <span className="flex-1 rounded-sm bg-lv0" />}
      {sorted.map((s, i) => (
        <span
          key={i}
          className={`flex-1 rounded-sm ${FILL[s.level]} ${s.due && size === "md" ? "outline-2 outline-offset-1 outline-due" : ""}`}
        />
      ))}
    </div>
  );
}

export function LevelCounts({ rollup }: { rollup: LevelRollup }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted">
      {rollup.counts.map((n, lv) =>
        n ? (
          <span key={lv} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${FILL[lv]}`} aria-hidden="true" />
            {n} {LEVELS[lv].name}
          </span>
        ) : null,
      )}
      {rollup.due > 0 && (
        <span className="inline-flex items-center gap-1.5 text-amber-ink">
          <span className="size-2 rounded-full bg-due" aria-hidden="true" />
          {rollup.due} due for review
        </span>
      )}
    </div>
  );
}

export function LevelLegend() {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted" aria-label="Level key">
      {LEVELS.map((l, lv) => (
        <span key={l.name} className="inline-flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${FILL[lv]}`} aria-hidden="true" />
          {l.name}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full border-2 border-due" aria-hidden="true" />
        Review due
      </span>
    </div>
  );
}

/** Headline, bar and counts for a topic or module. */
export function RollupSummary({ rollup, subtopics }: { rollup: LevelRollup; subtopics: { level: Level; due: boolean }[] }) {
  return (
    <div className="space-y-3">
      <p className="text-[15px]">
        <strong className="font-semibold">
          {rollup.checked} of {rollup.total}
        </strong>{" "}
        subtopics checked on your own
      </p>
      <LevelBar subtopics={subtopics} label={rollupSentence(rollup)} />
      <LevelCounts rollup={rollup} />
    </div>
  );
}

export function HowLevelsWork() {
  return (
    <details className="rounded-xl border border-line bg-card px-5 py-4" data-testid="how-levels-work">
      <summary className="font-medium">How levels work</summary>
      <ol className="mt-3 grid gap-2.5">
        {LEVELS.map((l, lv) => (
          <li key={l.name} className="grid gap-1 text-sm sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-3">
            <span>
              <LevelPill level={lv as Level} />
            </span>
            <span>{l.meaning}</span>
          </li>
        ))}
        <li className="grid gap-1 text-sm sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-3">
          <span>
            <DuePill />
          </span>
          <span>
            Time to show you still remember it. Being overdue never lowers a level, but a review answered wrong drops the subtopic back to
            Learning until you get it right on your own again.
          </span>
        </li>
      </ol>
      <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
        A subtopic is as strong as its weakest required skill. Topics and modules count how many subtopics are at each level; they are never
        averaged into a percentage. Explanations, hints, feedback and corrections count as practice. Only a first answer given with no help
        can reach Checked or Secure.
      </p>
    </details>
  );
}
