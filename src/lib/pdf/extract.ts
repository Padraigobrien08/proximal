// Text-PDF extraction by page with pdfjs-dist in Node (legacy build, per the official Node example).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const LOW_TEXT_THRESHOLD = 40;

export interface ExtractedPage {
  pageNumber: number;
  /** Text items joined; item boundaries preserved as spaces, line ends as newlines. */
  text: string;
  items: string[];
  lowTextWarning: boolean;
}

export class PdfImportError extends Error {
  constructor(
    message: string,
    readonly code: "too_large" | "not_pdf" | "encrypted" | "malformed" | "too_many_pages" | "empty",
  ) {
    super(message);
    this.name = "PdfImportError";
  }
}

export function checkPdfSignature(bytes: Uint8Array): boolean {
  // %PDF- within the first 1024 bytes (the spec allows leading junk).
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString("latin1");
  return head.includes("%PDF-");
}

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPage[]> {
  if (bytes.length > MAX_PDF_BYTES) throw new PdfImportError("PDF is larger than 10 MB.", "too_large");
  if (bytes.length === 0) throw new PdfImportError("The file is empty.", "empty");
  if (!checkPdfSignature(bytes)) throw new PdfImportError("This file is not a PDF (missing %PDF signature).", "not_pdf");

  // Copy: pdf.js may transfer/detach the buffer.
  const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") throw new PdfImportError("This PDF is encrypted or password-protected.", "encrypted");
    throw new PdfImportError("The PDF could not be parsed (it may be corrupt).", "malformed");
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new PdfImportError(`PDF has ${doc.numPages} pages; the limit is ${MAX_PDF_PAGES}.`, "too_many_pages");
    }
    const pages: ExtractedPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: string[] = [];
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        items.push(item.str);
        text += item.str;
        text += item.hasEOL ? "\n" : item.str.length > 0 && !item.str.endsWith(" ") ? " " : "";
      }
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      pages.push({
        pageNumber: i,
        text,
        items,
        lowTextWarning: text.replace(/\s/g, "").length < LOW_TEXT_THRESHOLD,
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
