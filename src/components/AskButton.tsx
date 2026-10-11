"use client";

import { MessagesSquare } from "lucide-react";
import { openChat } from "./dataEvents";

/** Opens "Ask your lectures" for a module. */
export function AskButton({ courseId, variant = "button" }: { courseId: string; variant?: "button" | "help" }) {
  return (
    <button
      type="button"
      onClick={() => openChat(courseId)}
      data-testid="open-chat"
      className={
        variant === "help"
          ? "inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-card px-4 text-sm font-medium text-ink transition-colors hover:border-teal hover:text-teal motion-reduce:transition-none"
          : "inline-flex min-h-11 items-center gap-2 rounded-[7px] border border-line-strong bg-card px-4 text-sm font-medium hover:border-teal hover:text-teal"
      }
    >
      <MessagesSquare size={16} aria-hidden="true" />
      Ask your lectures
    </button>
  );
}
