"use client";

// "Ask your lectures": a module-scoped chat drawer, opened from module, topic and session screens via openChat().
import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, MessageSquarePlus, X } from "lucide-react";
import { api, ApiError } from "./api";
import { notifyDataChanged, OPEN_CHAT } from "./dataEvents";
import { MathText } from "./MathText";

interface Citation {
  sourceId: string;
  sourceLabel: string;
  page: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  covered: boolean;
  origin: "live" | "offline" | "error";
}

interface ChatData {
  module: { id: string; title: string };
  threadId: string | null;
  messages: Message[];
  pageCount: number;
  mode: "live" | "offline";
  helpWindowHours: number;
}

const SUGGESTIONS = ["Summarise this lecture in five points", "What are the key terms I should know?", "Explain the hardest idea simply"];

export function ChatDrawer() {
  const [courseId, setCourseId] = useState<string | null>(null);
  const [data, setData] = useState<ChatData | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<{ courseId: string }>).detail.courseId;
      returnFocus.current = document.activeElement as HTMLElement | null;
      setError(null);
      setCourseId(id);
      api<ChatData>(`/api/courses/${id}/chat`).then(setData, (err) => setError(err instanceof ApiError ? err.message : "Could not open the chat."));
    };
    window.addEventListener(OPEN_CHAT, open);
    return () => window.removeEventListener(OPEN_CHAT, open);
  }, []);

  useEffect(() => {
    if (!courseId) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [courseId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length, pending]);

  function close() {
    setCourseId(null);
    setData(null);
    setPending(null);
    returnFocus.current?.focus();
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || !courseId || pending) return;
    setPending(question);
    setDraft("");
    setError(null);
    try {
      const res = await api<{ threadId: string; messages: Message[] }>(`/api/courses/${courseId}/chat`, {
        method: "POST",
        json: { question, threadId: data?.threadId ?? null },
      });
      setData((d) => (d ? { ...d, threadId: res.threadId, messages: [...d.messages, ...res.messages] } : d));
      // An open check may now count this as help.
      notifyDataChanged();
    } catch (err) {
      setDraft(question);
      setError(err instanceof ApiError ? err.message : "Could not send. Your question is still in the box.");
    } finally {
      setPending(null);
      inputRef.current?.focus();
    }
  }

  async function newChat() {
    if (!courseId) return;
    const res = await api<{ threadId: string }>(`/api/courses/${courseId}/chat/new`, { method: "POST", json: {} });
    setData((d) => (d ? { ...d, threadId: res.threadId, messages: [] } : d));
    inputRef.current?.focus();
  }

  if (!courseId) return null;
  const multiSource = new Set(data?.messages.flatMap((m) => m.citations.map((c) => c.sourceId))).size > 1;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/20 lg:hidden" onClick={close} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="false"
        aria-labelledby="chat-title"
        data-testid="chat-drawer"
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-card shadow-2xl sm:w-[440px]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id="chat-title" className="text-[17px] font-semibold tracking-tight">
              Ask your lectures
            </h2>
            <p className="truncate text-xs text-muted">{data?.module.title ?? "Loading…"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={newChat}
              disabled={!data?.messages.length}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-paper hover:text-ink disabled:opacity-40"
              aria-label="New conversation"
              title="New conversation"
            >
              <MessageSquarePlus size={18} aria-hidden="true" />
            </button>
            <button type="button" onClick={close} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-paper hover:text-ink" aria-label="Close chat">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <p className="border-b border-line bg-paper px-5 py-2.5 text-xs text-muted" data-testid="chat-notice">
          {data?.mode === "offline"
            ? "Offline demo: no AI answers. Shows the lecture pages that best match your question."
            : `Answers come from your lecture pages, with links. Asking about a subtopic counts as help for checks on it for the next ${data?.helpWindowHours ?? 3} hours.`}
        </p>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
          {data && data.messages.length === 0 && !pending && (
            <div className="space-y-3 pt-2">
              <p className="text-sm text-muted">
                Ask anything about {data.module.title}. {data.pageCount} lecture page{data.pageCount === 1 ? "" : "s"} available.
              </p>
              <div className="flex flex-col items-start gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line-strong px-3 py-1.5 text-left text-sm hover:border-teal hover:text-teal">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {data?.messages.map((m) => (
            <ChatBubble key={m.id} message={m} showSource={multiSource} onRetry={m.origin === "error" ? () => send(lastQuestionBefore(data.messages, m.id)) : undefined} />
          ))}
          {pending && (
            <>
              <ChatBubble message={{ id: "pending", role: "user", content: pending, citations: [], covered: true, origin: "live" }} showSource={false} />
              <p className="text-sm text-muted" role="status">
                Reading your lecture pages…
              </p>
            </>
          )}
          {error && <p className="rounded-lg bg-red-soft px-3 py-2 text-sm text-red-ink">{error}</p>}
          <div ref={endRef} />
        </div>

        <form
          className="border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-card p-2 focus-within:border-teal">
            <label htmlFor="chat-input" className="sr-only">
              Ask about your lectures
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              data-testid="chat-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder="Ask about your lectures…"
              className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-1.5 py-1 text-[15px] outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim() || !!pending}
              data-testid="chat-send"
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-40"
              aria-label="Send"
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-muted">Enter to send · Shift+Enter for a new line</p>
        </form>
      </aside>
    </>
  );
}

function lastQuestionBefore(messages: Message[], id: string): string {
  const i = messages.findIndex((m) => m.id === id);
  return [...messages.slice(0, i)].reverse().find((m) => m.role === "user")?.content ?? "";
}

function ChatBubble({ message: m, showSource, onRetry }: { message: Message; showSource: boolean; onRetry?: () => void }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-teal-soft px-3.5 py-2 text-[15px]">{m.content}</p>
      </div>
    );
  }
  if (m.origin === "error") {
    return (
      <div className="rounded-lg bg-red-soft px-3 py-2 text-sm text-red-ink" data-testid="chat-answer">
        <p>{m.content}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-1 underline">
            Try again
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="chat-answer">
      {!m.covered && (
        <span className="inline-flex rounded-md bg-amber-soft px-2 py-0.5 text-[11px] font-medium text-amber-ink">Not from your lecture material</span>
      )}
      <div className="space-y-2 text-[15px] leading-relaxed">
        {m.content.split(/\n{2,}/).map((para, i) => {
          const lines = para.split("\n");
          if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
            return (
              <ul key={i} className="list-disc space-y-1 pl-5">
                {lines.map((l, j) => (
                  <li key={j}>
                    <MathText text={l.replace(/^\s*[-•]\s+/, "").replace(/\*\*/g, "")} />
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <p key={i} className="whitespace-pre-wrap">
              <MathText text={para.replace(/\*\*/g, "")} />
            </p>
          );
        })}
      </div>
      {m.citations.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="chat-citations">
          <span className="text-[11px] text-muted">{m.origin === "offline" ? "Matching pages:" : "From:"}</span>
          {m.citations.map((c) => (
            <a
              key={`${c.sourceId}-${c.page}`}
              href={`/api/sources/${c.sourceId}#page=${c.page}`}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs text-teal hover:border-teal"
            >
              <FileText size={12} aria-hidden="true" />
              {showSource ? `${c.sourceLabel}, ` : ""}p. {c.page}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
