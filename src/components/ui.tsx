"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-card p-5 shadow-[0_1px_0_rgba(0,0,0,0.02)] ${className}`}>{children}</section>;
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-teal text-white hover:bg-teal-dark disabled:bg-teal/50",
  secondary: "border border-line bg-card text-ink hover:border-teal hover:text-teal disabled:opacity-50",
  ghost: "text-teal hover:underline disabled:opacity-50",
  danger: "border border-red-ink/30 bg-card text-red-ink hover:bg-red-soft disabled:opacity-50",
};

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function ButtonLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: ButtonVariant }) {
  return (
    <Link href={href} className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium ${VARIANTS[variant]}`}>
      {children}
    </Link>
  );
}

export function Notice({ tone = "info", children, title }: { tone?: "info" | "warn" | "error" | "good"; children: ReactNode; title?: string }) {
  const tones = {
    info: "border-sky-ink/20 bg-sky-soft text-sky-ink",
    warn: "border-amber-ink/20 bg-amber-soft text-amber-ink",
    error: "border-red-ink/20 bg-red-soft text-red-ink",
    good: "border-green-ink/20 bg-green-soft text-green-ink",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="py-10 text-center text-sm text-muted">
      {label}
    </p>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "info" | "good" | "warn" | "teal" }) {
  const tones = {
    neutral: "bg-line/60 text-muted",
    info: "bg-sky-soft text-sky-ink",
    good: "bg-green-soft text-green-ink",
    warn: "bg-amber-soft text-amber-ink",
    teal: "bg-teal-soft text-teal-dark",
  };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function newSubmissionKey(): string {
  return crypto.randomUUID();
}
