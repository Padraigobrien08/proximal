"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BookOpen, LayoutDashboard, Plus, Settings, X } from "lucide-react";
import { vendorName } from "@/lib/domain/labels";
import type { Level } from "@/lib/domain/levels";
import { LevelBar } from "./levels";
import { OPEN_IMPORT } from "./dataEvents";
import { ChatDrawer } from "./ChatDrawer";
import { ImportPanel } from "./ImportPanel";
import type { ProviderInfo } from "./ProviderBadge";
import { useApiResource } from "./useApiResource";

interface ShellData {
  provider: ProviderInfo;
  courses: { id: string; title: string; status: "draft" | "approved"; subtopicLevels: { level: Level; due: boolean }[] }[];
}

function section(pathname: string): string {
  if (pathname === "/") return "Overview";
  if (pathname === "/courses") return "Modules";
  if (pathname.startsWith("/courses/")) return "Module";
  if (pathname.startsWith("/topics/")) return "Topic";
  if (pathname.startsWith("/sessions/")) return "Session";
  if (pathname.startsWith("/runs/")) return "Session complete";
  if (pathname === "/settings") return "Settings";
  return "Workspace";
}

export function providerShortLabel(p: ProviderInfo | undefined): string {
  if (!p) return "";
  if (p.mode === "mock") return "Offline demo · supplied examples only";
  return p.ready ? `${vendorName(p.vendor)} assessment · ${p.model}` : `${vendorName(p.vendor)} assessment unavailable`;
}

/** Shared workspace shell: sidebar navigation, breadcrumb, import dialog and compact provider status. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data } = useApiResource<ShellData>("/api/courses");
  const [importOpen, setImportOpen] = useState(false);
  const here = section(pathname);

  useEffect(() => {
    const open = () => setImportOpen(true);
    window.addEventListener(OPEN_IMPORT, open);
    return () => window.removeEventListener(OPEN_IMPORT, open);
  }, []);

  const nav = [
    { href: "/", label: "Overview", Icon: LayoutDashboard, active: pathname === "/" },
    { href: "/courses", label: "Modules", Icon: BookOpen, active: pathname === "/courses" || pathname.startsWith("/courses/") },
    { href: "/settings", label: "Settings", Icon: Settings, active: pathname === "/settings" },
  ];

  return (
    <div className="min-h-screen bg-paper text-ink md:grid md:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[216px_minmax(0,1fr)]">
      <aside
        aria-label="Workspace"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-side px-4 py-3 text-side-ink md:sticky md:top-0 md:h-screen md:flex-col md:flex-nowrap md:items-stretch md:justify-start md:gap-7 md:px-4 md:py-6"
      >
        <Link href="/" className="flex min-h-11 items-center gap-2.5 px-2 text-[21px] font-semibold tracking-tight md:text-2xl">
          <span aria-hidden="true" className="grid size-[26px] place-items-center rounded-lg bg-side-ink text-[19px] font-medium text-side">
            p
          </span>
          Proximal
        </Link>
        <nav aria-label="Main" className="flex gap-1 md:flex-col md:gap-1.5">
          {nav.map(({ href, label, Icon, active }) => (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors motion-reduce:transition-none ${
                active ? "bg-side-active text-side-ink" : "text-side-muted hover:text-side-ink"
              }`}
            >
              <Icon size={17} aria-hidden="true" className="hidden md:block" />
              {label}
            </Link>
          ))}
        </nav>
        {data && data.courses.length > 0 && (
          <div className="hidden md:block">
            <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-[0.1em] text-side-muted">Your modules</p>
            <ul className="space-y-0.5">
              {data.courses.map((c) => {
                const href = `/courses/${c.id}`;
                const active = pathname === href;
                return (
                  <li key={c.id}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded-lg px-3 py-2 text-[13px] leading-snug ${
                        active ? "bg-side-active text-side-ink" : "text-side-ink/90 hover:text-side-ink hover:underline"
                      }`}
                    >
                      {c.title}
                      {c.status === "draft" ? (
                        <span className="block text-[11px] text-side-muted">Draft</span>
                      ) : (
                        <span className="mt-1.5 block">
                          <LevelBar subtopics={c.subtopicLevels ?? []} size="sm" />
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="mt-auto hidden border-t border-side-active px-3 pt-5 text-xs text-side-muted md:block" data-testid="shell-provider">
          <strong className="mb-0.5 block font-medium text-side-ink">Personal workspace</strong>
          {providerShortLabel(data?.provider)}
          <span className="mt-1 block">Local only · 127.0.0.1</span>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="border-b border-line">
          <div className="mx-auto flex min-h-[64px] max-w-[1120px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <p className="flex items-center gap-2 text-xs text-muted">
              Workspace <span aria-hidden="true">/</span>
              <span className="font-medium text-ink">{here}</span>
            </p>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              data-testid="toggle-import"
              className="inline-flex min-h-10 items-center gap-2 rounded-[7px] border border-line-strong bg-card px-3.5 text-sm font-medium text-ink transition-colors hover:border-teal hover:text-teal motion-reduce:transition-none"
            >
              <Plus size={16} aria-hidden="true" />
              Import lecture
            </button>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ChatDrawer />
    </div>
  );
}

/** Accessible modal (native <dialog>): focus moves inside, Escape closes, focus returns to the trigger. */
function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Navigating to the new draft closes the dialog.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname && open) onClose();
    lastPath.current = pathname;
  }, [pathname, open, onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="import-title"
      onClose={() => {
        onClose();
        returnFocus.current?.focus();
      }}
      className="m-auto w-[min(640px,calc(100vw-2rem))] rounded-xl border border-line bg-card p-0 text-ink shadow-xl backdrop:bg-ink/40"
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
        <div>
          <h2 id="import-title" className="text-[17px] font-semibold">
            Import a lecture
          </h2>
          <p className="text-xs text-muted">Add a text-based lecture PDF to organise its learning objectives.</p>
        </div>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="grid size-10 place-items-center rounded-lg text-muted hover:bg-paper hover:text-ink"
          aria-label="Close import dialog"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="px-6 py-5">{open && <ImportPanel />}</div>
    </dialog>
  );
}
