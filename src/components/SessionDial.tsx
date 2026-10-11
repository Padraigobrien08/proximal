"use client";

// Pomodoro-style session length dial: drag around the ring, or use the arrow keys. Five-minute steps up to an hour.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const SIZE = 156;
const STROKE = 12;
const R = (SIZE - STROKE) / 2 - 8;
const C = SIZE / 2;
const CIRC = 2 * Math.PI * R;

function point(minutes: number, radius = R) {
  const a = (minutes / 60) * 2 * Math.PI - Math.PI / 2;
  return { x: C + radius * Math.cos(a), y: C + radius * Math.sin(a) };
}

export function SessionDial({
  value,
  onChange,
  onCommit,
  min = 5,
  max = 60,
  step = 5,
}: {
  value: number;
  /** Every change while dragging (for the label). */
  onChange: (minutes: number) => void;
  /** The settled value (drag released or key pressed): refetch the plan here. */
  onCommit: (minutes: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (m: number) => Math.min(max, Math.max(min, Math.round(m / step) * step));

  function fromPointer(e: PointerEvent<SVGSVGElement>): number {
    const box = svgRef.current!.getBoundingClientRect();
    const x = e.clientX - box.left - box.width / 2;
    const y = e.clientY - box.top - box.height / 2;
    let turn = Math.atan2(y, x) / (2 * Math.PI) + 0.25; // 0 at 12 o'clock, clockwise
    if (turn < 0) turn += 1;
    const raw = turn * 60;
    // Crossing 12 o'clock does not wrap from an hour to five minutes (or back).
    if (value >= 45 && raw < 15) return max;
    if (value <= 15 && raw > 45) return min;
    return clamp(raw);
  }

  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onChange(fromPointer(e));
  }
  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    if (dragging) onChange(fromPointer(e));
  }
  function onPointerUp(e: PointerEvent<SVGSVGElement>) {
    if (!dragging) return;
    setDragging(false);
    onCommit(fromPointer(e));
  }
  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const next =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? value + step
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? value - step
          : e.key === "Home"
            ? min
            : e.key === "End"
              ? max
              : null;
    if (next === null) return;
    e.preventDefault();
    const m = clamp(next);
    onChange(m);
    onCommit(m);
  }

  const thumb = point(value);
  return (
    <svg
      ref={svgRef}
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="slider"
      tabIndex={0}
      aria-label="Session length"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} minutes`}
      data-testid="session-dial"
      className="shrink-0 cursor-pointer touch-none select-none rounded-full outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={onKeyDown}
    >
      {Array.from({ length: 12 }, (_, i) => {
        const m = i * 5;
        const a = point(m, R + STROKE / 2 + 5);
        const b = point(m, R + STROKE / 2 + (m % 15 === 0 ? 10 : 8));
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={m < value || (m === 0 && value === 60) ? "stroke-teal" : "stroke-line-strong"} strokeWidth={m % 15 === 0 ? 2 : 1.25} strokeLinecap="round" />;
      })}
      <circle cx={C} cy={C} r={R} fill="none" className="stroke-line" strokeWidth={STROKE} />
      <circle
        cx={C}
        cy={C}
        r={R}
        fill="none"
        className="stroke-teal"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={`${(value / 60) * CIRC} ${CIRC}`}
        transform={`rotate(-90 ${C} ${C})`}
        style={{ transition: dragging ? "none" : "stroke-dasharray 160ms ease-out" }}
      />
      <circle cx={thumb.x} cy={thumb.y} r={STROKE / 2 + 4} className="fill-card stroke-teal" strokeWidth={3} />
      <text x={C} y={C - 2} textAnchor="middle" className="fill-ink text-[34px] font-semibold tracking-tight">
        {value}
      </text>
      <text x={C} y={C + 22} textAnchor="middle" className="fill-muted text-[12px]">
        minutes
      </text>
    </svg>
  );
}
