"use client";

import katex from "katex";
import { useMemo } from "react";

type Part = { kind: "text"; value: string } | { kind: "math"; value: string };

export function splitMath(source: string): Part[] {
  const parts: Part[] = [];
  const re = /\$([^$]+)\$/g;
  let last = 0;
  for (const m of source.matchAll(re)) {
    if (m.index! > last) parts.push({ kind: "text", value: source.slice(last, m.index) });
    parts.push({ kind: "math", value: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < source.length) parts.push({ kind: "text", value: source.slice(last) });
  return parts;
}

/** Plain-text equivalent of authored TeX (for screen readers and copy). */
export function plainMath(tex: string): string {
  return tex
    .replace(/\\mid/g, "|")
    .replace(/\\theta/g, "θ")
    .replace(/\\(?:mathrm|text)\{([^}]*)\}/g, "$1")
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1)/($2)")
    .replace(/\\sum_?/g, "Σ")
    .replace(/\\prod_?/g, "Π")
    .replace(/\\(log|ln)/g, "$1")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\ge/g, "≥")
    .replace(/\\in/g, "∈")
    .replace(/\\approx/g, "≈")
    .replace(/\\to/g, "→")
    .replace(/\\,/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "");
}

/** Renders authored text with inline $...$ TeX through KaTeX (trust off). Learner text is never rendered as math/HTML. */
export function MathText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => splitMath(text), [text]);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.value}</span>
        ) : (
          <span key={i}>
            <span
              aria-hidden="true"
              dangerouslySetInnerHTML={{
                __html: katex.renderToString(p.value, { throwOnError: false, output: "html", trust: false, strict: "ignore" }),
              }}
            />
            <span className="sr-only">{plainMath(p.value)}</span>
          </span>
        ),
      )}
    </span>
  );
}
