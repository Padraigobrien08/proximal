// Renders PDF pages to JPEG for transcription of scanned pages, with pdf.js (legacy Node build) drawing onto
// @napi-rs/canvas.
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Long edge in pixels: legible for small lecture text while keeping each image to roughly 1-2k input tokens. */
export const RENDER_MAX_EDGE = 1600;
const JPEG_QUALITY = 85;

export interface RenderedPage {
  page: number;
  jpeg: Buffer;
  width: number;
  height: number;
}

export async function renderPagesAsJpeg(bytes: Uint8Array, pageNumbers: number[], maxEdge = RENDER_MAX_EDGE): Promise<RenderedPage[]> {
  if (pageNumbers.length === 0) return [];
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const out: RenderedPage[] = [];
    for (const n of pageNumbers) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: maxEdge / Math.max(base.width, base.height) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      // Scans are often transparent around the image; paint white so the JPEG is not black.
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      }).promise;
      out.push({ page: n, jpeg: canvas.toBuffer("image/jpeg", JPEG_QUALITY), width: canvas.width, height: canvas.height });
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}
