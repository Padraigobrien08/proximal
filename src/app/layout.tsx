import type { Metadata } from "next";
import Link from "next/link";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Proximal",
  description: "Local study app that tracks skill-level evidence, assistance and scheduled reviews.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen bg-paper text-ink">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-card focus:p-2">
          Skip to content
        </a>
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
      </body>
    </html>
  );
}
