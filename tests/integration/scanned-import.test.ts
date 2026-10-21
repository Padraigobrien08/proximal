import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { listSourcePages } from "../../src/lib/db/repo";
import { createMockProvider } from "../../src/lib/llm/factory";
import { ProviderError, type CurriculumInput, type LearningProvider, type TranscribeInput } from "../../src/lib/llm/types";
import { renderPagesAsJpeg, RENDER_MAX_EDGE } from "../../src/lib/pdf/render";
import { importPdf } from "../../src/lib/services/imports";
import { DEMO_SOURCE_FILE } from "../../src/lib/services/seed";
import { createTestContext } from "../helpers";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Pages given as strings get a text layer; pages given as { scan } are an image of that text only. */
async function pdf(pages: (string | { scan: string })[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([595, 842]);
    if (typeof p === "string") {
      page.drawText(p, { x: 50, y: 700, size: 12, font });
      continue;
    }
    const c = createCanvas(1240, 1754);
    const g = c.getContext("2d");
    g.fillStyle = "white";
    g.fillRect(0, 0, 1240, 1754);
    g.fillStyle = "black";
    g.font = "36px sans-serif";
    g.fillText(p.scan, 100, 200);
    page.drawImage(await doc.embedPng(c.toBuffer("image/png")), { x: 0, y: 0, width: 595, height: 842 });
  }
  return doc.save();
}

const TEXT_PAGE = "Gradient descent updates parameters against the gradient of the loss, scaled by the learning rate.";
const SCAN_TEXT = "A learning rate that is too large makes the loss diverge.";

/** A live-mode context whose transcriber and curriculum drafter are stubs recording their inputs. */
async function liveContext(transcribe: (i: TranscribeInput) => { text: string; legible: boolean } | Error) {
  const transcribeCalls: TranscribeInput[] = [];
  const curriculumCalls: CurriculumInput[] = [];
  const t = await createTestContext({
    mode: "live",
    provider: (db): LearningProvider => {
      const mock = createMockProvider(db);
      return Object.assign(mock, {
        transcribePage: async (i: TranscribeInput) => {
          transcribeCalls.push(i);
          const r = transcribe(i);
          if (r instanceof Error) throw r;
          return { transcription: r, meta: { mode: "live" as const, vendor: "openai" as const, model: "vision-test", promptVersion: "t", usage: null } };
        },
        generateCurriculum: async (i: CurriculumInput) => {
          curriculumCalls.push(i);
          return {
            draft: {
              topics: [
                {
                  title: "Optimisation",
                  units: [0, 1, 2].map((k) => {
                    const p = i.pages[k % i.pages.length];
                    return { title: `Unit ${k + 1}`, objective: `Explain page ${p.page}`, sourcePages: [p.page], skills: [{ objective: "Explain it" }] };
                  }),
                },
              ],
              suggestions: [],
            },
            meta: { mode: "live" as const, vendor: "openai" as const, model: "m", promptVersion: "c", usage: null },
          };
        },
      });
    },
  });
  cleanup = t.cleanup;
  return { ...t, transcribeCalls, curriculumCalls };
}

describe("rendering pages for transcription", () => {
  it("renders an image-only page to a JPEG with the configured long edge", async () => {
    const [r] = await renderPagesAsJpeg(await pdf([{ scan: SCAN_TEXT }]), [1]);
    expect(r.page).toBe(1);
    expect(r.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(Math.max(r.width, r.height)).toBe(RENDER_MAX_EDGE);
  });
});

describe("importing scanned PDFs", () => {
  it("transcribes only the pages without a text layer, labels them, and drafts from the transcription", async () => {
    const { ctx, dir, transcribeCalls, curriculumCalls } = await liveContext(() => ({ text: SCAN_TEXT, legible: true }));
    const res = await importPdf(ctx, dir, { name: "mixed.pdf", bytes: await pdf([TEXT_PAGE, { scan: SCAN_TEXT }, TEXT_PAGE]) });

    expect(transcribeCalls.map((c) => c.page)).toEqual([2]);
    expect(transcribeCalls[0].image.mediaType).toBe("image/jpeg");
    expect(Buffer.from(transcribeCalls[0].image.base64, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const pages = listSourcePages(ctx.db, res.sourceId);
    expect(pages.map((p) => p.transcribedBy)).toEqual([null, "openai:vision-test", null]);
    expect(pages[1]).toMatchObject({ text: SCAN_TEXT, lowTextWarning: false });
    expect(res.pages.map((p) => p.transcribed)).toEqual([false, true, false]);
    expect(res.message).toMatch(/1 scanned page was read from images by the AI/);
    // The curriculum is drafted from the transcribed text, not an empty page.
    expect(curriculumCalls[0].pages[1]).toEqual({ page: 2, text: SCAN_TEXT });
  });

  it("keeps an illegible page with its warning, and rejects a document where nothing is readable", async () => {
    const { ctx, dir } = await liveContext(() => ({ text: "", legible: false }));
    const mixed = await importPdf(ctx, dir, { name: "mixed.pdf", bytes: await pdf([TEXT_PAGE, { scan: "smudge" }]) });
    const pages = listSourcePages(ctx.db, mixed.sourceId);
    expect(pages[1]).toMatchObject({ lowTextWarning: true, transcribedBy: null });

    await expect(importPdf(ctx, dir, { name: "blank.pdf", bytes: await pdf([{ scan: "x" }, { scan: "y" }]) })).rejects.toThrow(
      /even after reading the page images/,
    );
  });

  it("fails the import, retryably, when transcription fails, and stores no course", async () => {
    const { ctx, dir, curriculumCalls } = await liveContext(() => new ProviderError("OpenAI rate limit or quota reached.", "provider_unavailable", true));
    await expect(importPdf(ctx, dir, { name: "scan.pdf", bytes: await pdf([{ scan: SCAN_TEXT }]) })).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
    expect(curriculumCalls).toHaveLength(0);
    expect(ctx.db.prepare("SELECT status FROM sources WHERE original_name = 'scan.pdf'").get()).toEqual({ status: "failed" });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM courses WHERE is_demo = 0").get()).toEqual({ n: 0 });
    // The failed upload's file is removed; the sources row keeps the error for display.
    expect(existsSync(path.join(dir, "uploads")) ? readdirSync(path.join(dir, "uploads")) : []).toEqual([DEMO_SOURCE_FILE]);
  });

  it("offline mode explains that reading page images needs a live provider", async () => {
    const t = await createTestContext();
    cleanup = t.cleanup;
    await expect(importPdf(t.ctx, t.dir, { name: "scan.pdf", bytes: await pdf([{ scan: SCAN_TEXT }]) })).rejects.toThrow(/needs a live provider/);
  });
});
