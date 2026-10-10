import type { Metadata } from "next";
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
        <a
          href="#main"
          className="sr-only z-50 focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-md focus:bg-card focus:p-2"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
