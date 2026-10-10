// Deterministic generation of the authored sample lecture with pdf-lib (text-based, importable).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { LectureFixture } from "../content/schemas";

const FIXED_DATE = new Date("2026-01-01T00:00:00Z");

function wrap(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (measure(candidate) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

export async function generateSampleLecturePdf(lecture: LectureFixture): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(lecture.title);
  doc.setAuthor("Proximal demo (authored sample)");
  doc.setSubject(lecture.label);
  doc.setProducer("proximal-seed");
  doc.setCreator("proximal-seed");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;

  for (const p of lecture.pages) {
    const page = doc.addPage([595.28, 841.89]); // A4
    const width = page.getWidth() - margin * 2;
    let y = page.getHeight() - margin;
    page.drawText(`${lecture.title} - ${lecture.label}`, { x: margin, y, size: 8, font: body, color: rgb(0.4, 0.4, 0.4) });
    y -= 28;
    page.drawText(p.heading, { x: margin, y, size: 16, font: bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 26;
    for (const para of p.paragraphs) {
      for (const line of wrap(para, width, (s) => body.widthOfTextAtSize(s, 11))) {
        page.drawText(line, { x: margin, y, size: 11, font: body, color: rgb(0.1, 0.1, 0.1) });
        y -= 15;
      }
      y -= 8;
    }
    page.drawText(`${lecture.notice}  Page ${p.page} of ${lecture.pages.length}`, {
      x: margin,
      y: margin - 20,
      size: 7,
      font: body,
      color: rgb(0.45, 0.45, 0.45),
    });
  }
  return doc.save({ useObjectStreams: false });
}
