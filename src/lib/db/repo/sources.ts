// Repository: uploaded sources and their extracted pages. Parameterised SQL only.
import { newId, type DB } from "./shared";

// ---------------------------------------------------------------- sources

export interface SourceRow {
  id: string;
  courseId: string | null;
  sha256: string;
  originalName: string;
  label: string | null;
  storedPath: string;
  pageCount: number | null;
  status: "processing" | "extracted" | "failed";
  error: string | null;
  createdAt: number;
}

interface RawSource {
  id: string;
  course_id: string | null;
  sha256: string;
  original_name: string;
  label: string | null;
  stored_path: string;
  page_count: number | null;
  status: SourceRow["status"];
  error: string | null;
  created_at: number;
}
const mapSource = (r: RawSource): SourceRow => ({
  id: r.id,
  courseId: r.course_id,
  sha256: r.sha256,
  originalName: r.original_name,
  label: r.label,
  storedPath: r.stored_path,
  pageCount: r.page_count,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

export function insertSource(db: DB, s: Omit<SourceRow, "id"> & { id?: string }): string {
  const id = s.id ?? newId();
  db.prepare(
    `INSERT INTO sources (id, course_id, sha256, original_name, label, stored_path, page_count, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, s.courseId, s.sha256, s.originalName, s.label, s.storedPath, s.pageCount, s.status, s.error, s.createdAt);
  return id;
}

export function getSource(db: DB, id: string): SourceRow | null {
  const r = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as RawSource | undefined;
  return r ? mapSource(r) : null;
}

export function listSourcesForCourse(db: DB, courseId: string): SourceRow[] {
  return (db.prepare("SELECT * FROM sources WHERE course_id = ? ORDER BY created_at").all(courseId) as RawSource[]).map(mapSource);
}

export function findSourcesBySha(db: DB, sha: string): SourceRow[] {
  return (db.prepare("SELECT * FROM sources WHERE sha256 = ? ORDER BY created_at").all(sha) as RawSource[]).map(mapSource);
}

export function updateSource(db: DB, id: string, patch: Partial<Pick<SourceRow, "status" | "error" | "pageCount" | "courseId">>) {
  const s = getSource(db, id);
  if (!s) return;
  db.prepare("UPDATE sources SET status = ?, error = ?, page_count = ?, course_id = ? WHERE id = ?").run(
    patch.status ?? s.status,
    patch.error === undefined ? s.error : patch.error,
    patch.pageCount === undefined ? s.pageCount : patch.pageCount,
    patch.courseId === undefined ? s.courseId : patch.courseId,
    id,
  );
}

export interface SourcePageRow {
  sourceId: string;
  pageNumber: number;
  text: string;
  lowTextWarning: boolean;
  /** vendor:model that transcribed this page from its image; null when the text came from the PDF itself. */
  transcribedBy: string | null;
}

export function replaceSourcePages(
  db: DB,
  sourceId: string,
  pages: { pageNumber: number; text: string; lowTextWarning: boolean; transcribedBy?: string | null }[],
) {
  db.prepare("DELETE FROM source_pages WHERE source_id = ?").run(sourceId);
  const ins = db.prepare(
    "INSERT INTO source_pages (source_id, page_number, extracted_text, low_text_warning, transcribed_by) VALUES (?, ?, ?, ?, ?)",
  );
  for (const p of pages) ins.run(sourceId, p.pageNumber, p.text, p.lowTextWarning ? 1 : 0, p.transcribedBy ?? null);
}

export function listSourcePages(db: DB, sourceId: string): SourcePageRow[] {
  return (
    db
      .prepare(
        "SELECT source_id, page_number, extracted_text, low_text_warning, transcribed_by FROM source_pages WHERE source_id = ? ORDER BY page_number",
      )
      .all(sourceId) as { source_id: string; page_number: number; extracted_text: string; low_text_warning: number; transcribed_by: string | null }[]
  ).map((r) => ({
    sourceId: r.source_id,
    pageNumber: r.page_number,
    text: r.extracted_text,
    lowTextWarning: !!r.low_text_warning,
    transcribedBy: r.transcribed_by,
  }));
}
