"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, ApiError } from "./api";
import { Button, Notice } from "./ui";

interface ImportResult {
  courseId: string;
  reused: boolean;
  curriculum: "generated" | "fixture" | "manual_required";
  message: string;
  pages: { page: number; lowTextWarning: boolean; charCount: number }[];
}

export function ImportPanel() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ status: "idle" | "processing" | "done" | "error"; message?: string; result?: ImportResult }>({
    status: "idle",
  });

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) {
      setState({ status: "error", message: "Choose a PDF first." });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setState({ status: "error", message: "PDF is larger than 10 MB." });
      return;
    }
    setState({ status: "processing" });
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await api<ImportResult>("/api/import", { method: "POST", body: form });
      setState({ status: "done", result, message: result.message });
    } catch (err) {
      setState({ status: "error", message: err instanceof ApiError ? err.message : "Upload failed." });
    }
  }

  return (
    <div className="space-y-3" aria-live="polite">
      <p className="text-sm text-muted">
        Text-based PDF, up to 10 MB and 50 pages. Text is extracted page by page; scanned pages and equations may not extract
        correctly and are flagged for review. Objectives always start as an editable draft.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="sr-only">PDF file</span>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            data-testid="import-file"
            className="block text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-card file:px-3 file:py-1.5 file:text-sm"
          />
        </label>
        <Button onClick={upload} disabled={state.status === "processing"} data-testid="import-submit">
          {state.status === "processing" ? "Extracting text…" : "Import PDF"}
        </Button>
      </div>
      {state.status === "processing" && <Notice>Processing the PDF. This runs locally and may take a few seconds.</Notice>}
      {state.status === "error" && <Notice tone="error">{state.message}</Notice>}
      {state.status === "done" && state.result && (
        <Notice tone={state.result.curriculum === "manual_required" ? "warn" : "good"} title="Import finished">
          <p>{state.message}</p>
          <p className="mt-1">
            {state.result.pages.length} page(s) extracted
            {state.result.pages.some((p) => p.lowTextWarning) &&
              `; low-text warning on page(s) ${state.result.pages.filter((p) => p.lowTextWarning).map((p) => p.page).join(", ")}`}
            .
          </p>
          <Button className="mt-2" onClick={() => router.push(`/courses/${state.result!.courseId}`)} data-testid="open-draft">
            Review draft curriculum
          </Button>
        </Notice>
      )}
    </div>
  );
}
