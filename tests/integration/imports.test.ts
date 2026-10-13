import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { approveCourse, importPdf, patchDraft } from "../../src/lib/services/imports";
import { getCourseView } from "../../src/lib/services/views";
import { startSession } from "../../src/lib/services/sessions";
import { MAX_PDF_BYTES } from "../../src/lib/pdf/extract";
import { createTestContext } from "../helpers";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup() {
  const t = await createTestContext();
  cleanup = t.cleanup;
  return t;
}

async function pdfWithPages(texts: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of texts) {
    const page = doc.addPage();
    if (t) page.drawText(t, { x: 50, y: 700, size: 12, font });
  }
  return doc.save();
}

describe("T18: PDF import", () => {
  it("valid sample yields a fixture draft with correct page refs; edits; explicit approval; review disabled", async () => {
    const { ctx, dir } = await setup();
    const res = await importPdf(ctx, dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
    expect(res.curriculum).toBe("fixture");
    expect(res.pages).toHaveLength(6);
    expect(res.pages.every((p) => !p.lowTextWarning)).toBe(true);

    let view = getCourseView(ctx, res.courseId);
    expect(view.course.status).toBe("draft");
    const units = view.topics.flatMap((t) => t.units);
    expect(units.map((u) => u.sourcePages)).toEqual([[1], [2], [3], [4], [5], [6]]);
    expect(view.sources[0].pages[3].text).toContain("Meaning of binary cross-entropy");
    expect(view.sources[0].label).toBe("Authored sample lecture");

    // Draft edits: title/objective, required toggle, deletion.
    patchDraft(ctx, res.courseId, {
      units: [
        { unitId: units[0].id, title: "Notation (edited)", skills: [{ skillId: units[0].skills[0].id, required: false }] },
        { unitId: units[5].id, delete: true },
      ],
      addUnits: [],
    });
    view = getCourseView(ctx, res.courseId);
    expect(view.topics.flatMap((t) => t.units)).toHaveLength(5);
    expect(view.topics[0].units[0].title).toBe("Notation (edited)");
    expect(view.topics[0].units[0].skills[0].required).toBe(false);

    // Study is blocked until approval.
    expect(() => startSession(ctx, { topicId: view.topics[0].id, mode: "learn" })).toThrow(/Approve/);
    approveCourse(ctx, res.courseId);
    view = getCourseView(ctx, res.courseId);
    expect(view.course.status).toBe("approved");
    // Approved imports have no reviewed question bank: review disabled, honest message.
    expect(() => startSession(ctx, { topicId: view.topics[0].id, mode: "review" })).toThrow(/Reviewed assessment questions needed/);
    expect(() => patchDraft(ctx, res.courseId, { units: [{ unitId: view.topics[0].units[0].id, title: "x" }], addUnits: [] })).toThrow(/frozen/);

    // A material change after approval becomes a new unit version with new skill ids (fresh evidence).
    const before = view.topics[0].units[0];
    patchDraft(ctx, res.courseId, { revisions: [{ unitId: before.id, objective: "Interpret p(y | x, theta) for a binary classifier" }] });
    const revised = getCourseView(ctx, res.courseId).topics[0].units.find((u) => u.version === 2)!;
    expect(revised.objective).toBe("Interpret p(y | x, theta) for a binary classifier");
    expect(revised.skills[0].id).not.toBe(before.skills[0].id);
    expect(getCourseView(ctx, res.courseId).topics[0].units.some((u) => u.id === before.id)).toBe(false); // superseded hidden

    // Retry of the same bytes reuses the course rather than duplicating it.
    const again = await importPdf(ctx, dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
    expect(again.reused).toBe(true);
    expect(again.courseId).toBe(res.courseId);
  });

  it("other text PDFs in mock mode extract text and require manual objectives", async () => {
    const { ctx, dir } = await setup();
    const bytes = await pdfWithPages([
      "Gradient descent updates parameters in the direction of the negative gradient of the loss.",
      "",
    ]);
    const res = await importPdf(ctx, dir, { name: "notes.pdf", bytes });
    expect(res.curriculum).toBe("manual_required");
    expect(res.message).toContain("Offline mode cannot generate a curriculum for this file.");
    expect(res.pages[1].lowTextWarning).toBe(true);
    expect(res.pages[0].lowTextWarning).toBe(false);
    patchDraft(ctx, res.courseId, {
      units: [],
      addUnits: [{ topicTitle: "Optimisation", title: "Gradient step", objective: "Explain a gradient descent update", sourcePages: [1] }],
    });
    expect(() =>
      patchDraft(ctx, res.courseId, { units: [], addUnits: [{ topicTitle: "X", title: "Bad", objective: "Bad page", sourcePages: [9] }] }),
    ).toThrow(/does not exist/);
    approveCourse(ctx, res.courseId);
    expect(getCourseView(ctx, res.courseId).course.status).toBe("approved");
  });

  it("empty/scanned, corrupt, non-PDF, encrypted-like and oversized files produce actionable errors", async () => {
    const { ctx, dir } = await setup();
    const scanned = await pdfWithPages(["", ""]);
    await expect(importPdf(ctx, dir, { name: "scan.pdf", bytes: scanned })).rejects.toThrow(/scanned or image-only PDF; reading page images needs a live provider/);
    await expect(importPdf(ctx, dir, { name: "bad.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nthis is not really a pdf") })).rejects.toThrow(
      /could not be parsed/,
    );
    await expect(importPdf(ctx, dir, { name: "x.pdf", bytes: new TextEncoder().encode("hello world") })).rejects.toThrow(/not a PDF/);
    await expect(importPdf(ctx, dir, { name: "big.pdf", bytes: new Uint8Array(MAX_PDF_BYTES + 1) })).rejects.toMatchObject({ code: "too_large" });
    const tooMany = await pdfWithPages(Array.from({ length: 51 }, (_, i) => `Page ${i + 1} has enough words to avoid the low-text heuristic here.`));
    await expect(importPdf(ctx, dir, { name: "long.pdf", bytes: tooMany })).rejects.toThrow(/limit is 50/);
    // Failures are persisted with status and error.
    const failed = ctx.db.prepare("SELECT status, error FROM sources WHERE status = 'failed'").all() as { status: string; error: string }[];
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed.every((f) => f.error.length > 0)).toBe(true);
  });
});
