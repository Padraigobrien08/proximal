import Link from "next/link";

/** Shell for course, topic and session screens. The home page renders its own workspace layout. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-line bg-paper/90">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
          <Link href="/" className="font-serif text-xl font-semibold tracking-tight text-ink">
            Proximal
          </Link>
          <span className="text-xs text-muted">Local single-user study app · 127.0.0.1 only</span>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-5 py-8">
        {children}
      </main>
    </>
  );
}
