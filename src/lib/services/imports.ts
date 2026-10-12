// Bounded synchronous PDF import (long documents drafted in parts), draft curriculum editing and explicit approval.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  findSourcesBySha,
  getCourse,
  getSource,
  getUnit,
  insertCourse,
  insertExposure,
  insertSkill,
  insertSource,
  insertTopic,
  insertUnit,
  listActiveSessionsForCourse,
  listSkillsForTopic,
  listSkillsForUnit,
  listSourcePages,
  listTopics,
  listUnits,
  replaceSourcePages,
  setCourseStatus,
  skillUsedInSession,
  updateSkill,
  updateSource,
  updateUnit,
  deleteUnit,
} from "../db/repo";
import { extractPdfText, LOW_TEXT_THRESHOLD, MAX_PDF_BYTES, PdfImportError, type ExtractedPage } from "../pdf/extract";
import { renderPagesAsJpeg } from "../pdf/render";
import { mergeCurriculumDrafts, planCurriculumParts, type CurriculumPart } from "../content/chunking";
import { validateCurriculumDraft } from "../llm/schemas";
import { OFFLINE_OCR_MESSAGE, ProviderError, type CurriculumDraft } from "../llm/types";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";

/**
 * One request per part, run concurrently (the metered provider caps how many are in flight). Each part is validated
 * against its own pages. Any failing part fails the whole import, so a partial curriculum is never stored as if
 * complete. A single-part document is sent exactly as before, without part markers.
 */
/**
 * Render each scanned page and have the live model transcribe it, at most `concurrency`-many at once through the
 * metered provider. Any provider failure fails the import (retryable); an illegible page is kept with its warning.
 */
async function transcribePages(ctx: AppContext, bytes: Uint8Array, pageNumbers: number[]): Promise<Map<number, { text: string; legible: boolean; by: string }>> {
  if (!ctx.provider.transcribePage) throw new AppError("provider_unavailable", "This provider cannot read page images.");
  const rendered = await renderPagesAsJpeg(bytes, pageNumbers);
  const results = await Promise.all(
    rendered.map(async (r) => {
      const { transcription, meta } = await ctx.provider.transcribePage!({ page: r.page, image: { mediaType: "image/jpeg", base64: r.jpeg.toString("base64") } });
      return [r.page, { ...transcription, by: `${meta.vendor ?? "live"}:${meta.model}` }] as const;
    }),
  );
  return new Map(results);
}

export async function draftCurriculumInParts(
  ctx: AppContext,
  doc: { sha256: string; fileName: string; pageCount: number },
  parts: CurriculumPart[],
): Promise<CurriculumDraft> {
  const single = parts.length === 1;
  const drafts = await Promise.all(
    parts.map(async (part) => {
      const res = await ctx.provider.generateCurriculum({
        sha256: doc.sha256,
        fileName: doc.fileName,
        pages: part.pages,
        ...(single ? {} : { part: { index: part.index, total: part.total, documentPageCount: doc.pageCount } }),
      });
      const problems = validateCurriculumDraft(res.draft, { pages: part.pages.map((p) => p.page), part: !single });
      if (problems.length > 0) {
        const where = single ? "" : ` (part ${part.index} of ${part.total}, pages ${part.firstPage}-${part.lastPage})`;
        throw new AppError("provider_malformed", `Generated curriculum failed validation${where}: ${problems.join("; ")}`, true);
      }
      return res.draft;
    }),
  );
  return mergeCurriculumDrafts(drafts);
}

export interface ImportResult {
  courseId: string;
  sourceId: string;
  reused: boolean;
  curriculum: "generated" | "fixture" | "manual_required";
  message: string;
  pages: { page: number; lowTextWarning: boolean; charCount: number; transcribed: boolean }[];
}

export async function importPdf(
  ctx: AppContext,
  dataDir: string,
  file: { name: string; bytes: Uint8Array },
): Promise<ImportResult> {
  if (file.bytes.length > MAX_PDF_BYTES) throw new AppError("too_large", "PDF is larger than 10 MB.");
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const originalName = path.basename(file.name || "upload.pdf").slice(0, 200);

  // Retry safety: an existing extracted import of the same bytes is reused, never duplicated or overwritten.
  const prior = findSourcesBySha(ctx.db, sha256).find((s) => s.status === "extracted" && s.courseId && getCourse(ctx.db, s.courseId) && !getCourse(ctx.db, s.courseId)!.isDemo);
  if (prior) {
    const course = getCourse(ctx.db, prior.courseId!)!;
    return {
      courseId: course.id,
      sourceId: prior.id,
      reused: true,
      curriculum: listTopics(ctx.db, course.id).length > 0 ? "generated" : "manual_required",
      message:
        course.status === "approved"
          ? "This PDF was already imported and approved. Opening the existing course."
          : "This PDF was already imported. Opening the existing draft.",
      pages: listSourcePages(ctx.db, prior.id).map((p) => ({
        page: p.pageNumber,
        lowTextWarning: p.lowTextWarning,
        charCount: p.text.replace(/\s/g, "").length,
        transcribed: p.transcribedBy !== null,
      })),
    };
  }

  const uploadsDir = path.join(dataDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const storedName = `${randomBytes(16).toString("hex")}.pdf`;
  const storedPath = path.join(uploadsDir, storedName);
  writeFileSync(storedPath, file.bytes, { flag: "wx" });

  const now = ctx.clock.now();
  const sourceId = insertSource(ctx.db, {
    courseId: null,
    sha256,
    originalName,
    label: null,
    storedPath: storedName,
    pageCount: null,
    status: "processing",
    error: null,
    createdAt: now,
  });

  let pages: ExtractedPage[];
  try {
    pages = await extractPdfText(file.bytes);
  } catch (err) {
    const message = err instanceof PdfImportError ? err.message : "The PDF could not be processed.";
    updateSource(ctx.db, sourceId, { status: "failed", error: message });
    throw new AppError("pdf_rejected", message);
  }
  // Pages with (almost) no extractable text are probably scanned: a live provider reads them from a rendered image.
  let transcribed: Map<number, { text: string; legible: boolean; by: string }> = new Map();
  const scanned = pages.filter((p) => p.lowTextWarning).map((p) => p.pageNumber);
  if (scanned.length > 0 && ctx.providerStatus.mode === "live") {
    try {
      transcribed = await transcribePages(ctx, file.bytes, scanned);
    } catch (err) {
      const e = err instanceof ProviderError ? new AppError(err.code, err.message, err.retryable) : err instanceof AppError ? err : null;
      if (!e) throw err;
      updateSource(ctx.db, sourceId, { status: "failed", error: e.message, pageCount: pages.length });
      throw e;
    }
    pages = pages.map((p) => {
      const t = transcribed.get(p.pageNumber);
      if (!t || !t.legible) return p;
      return { ...p, text: t.text.trim(), lowTextWarning: t.text.replace(/\s/g, "").length < LOW_TEXT_THRESHOLD };
    });
  }
  if (pages.every((p) => p.lowTextWarning)) {
    const message =
      scanned.length === 0 || ctx.providerStatus.mode !== "live"
        ? OFFLINE_OCR_MESSAGE
        : "No readable text was found, even after reading the page images. Check that the scan is legible.";
    updateSource(ctx.db, sourceId, { status: "failed", error: message, pageCount: pages.length });
    throw new AppError("pdf_rejected", message);
  }

  let draft: CurriculumDraft | null = null;
  let message: string;
  let curriculum: ImportResult["curriculum"];
  let generationError: AppError | null = null;
  // Long documents are drafted in parts of whole consecutive pages; nothing is truncated or dropped.
  const plan = planCurriculumParts(pages.map((p) => ({ page: p.pageNumber, text: p.text })));
  if (!plan.ok) {
    generationError = new AppError("too_large", plan.reason);
  } else {
    try {
      draft = await draftCurriculumInParts(ctx, { sha256, fileName: originalName, pageCount: pages.length }, plan.parts);
    } catch (err) {
      if (err instanceof ProviderError && err.code === "offline_unsupported") {
        message = err.message;
      } else if (err instanceof ProviderError) {
        generationError = new AppError(err.code, err.message, err.retryable);
      } else if (err instanceof AppError) {
        generationError = err;
      } else throw err;
    }
  }
  if (generationError) {
    updateSource(ctx.db, sourceId, { status: "failed", error: generationError.message, pageCount: pages.length });
    throw generationError;
  }

  const isSample = ctx.providerStatus.mode === "mock" && draft !== null;
  const courseId = ctx.db.transaction(() => {
    const courseId = insertCourse(ctx.db, {
      title: originalName.replace(/\.pdf$/i, ""),
      isDemo: false,
      status: "draft",
      suggestions: draft?.suggestions ?? [],
      notice: draft ? null : "Offline mode cannot generate a curriculum for this file. Add objectives manually.",
      createdAt: now,
    });
    replaceSourcePages(
      ctx.db,
      sourceId,
      pages.map((p) => {
        const t = transcribed.get(p.pageNumber);
        return { pageNumber: p.pageNumber, text: p.text, lowTextWarning: p.lowTextWarning, transcribedBy: t?.legible ? t.by : null };
      }),
    );
    updateSource(ctx.db, sourceId, { status: "extracted", pageCount: pages.length, courseId, error: null });
    ctx.db.prepare("UPDATE sources SET label = ? WHERE id = ?").run(isSample ? "Authored sample lecture" : originalName, sourceId);
    if (draft) {
      draft.topics.forEach((t, ti) => {
        const topicId = insertTopic(ctx.db, { courseId, title: t.title, position: ti + 1 });
        t.units.forEach((u, ui) => {
          const unitId = insertUnit(ctx.db, {
            topicId,
            title: u.title,
            objective: u.objective,
            approvalStatus: "draft",
            sourceRefs: u.sourcePages.map((page) => ({ page })),
            position: ui,
          });
          u.skills.forEach((s, si) =>
            insertSkill(ctx.db, { unitId, objective: s.objective, required: true, transferRequired: true, position: si }),
          );
        });
      });
    }
    return courseId;
  })();

  if (draft) {
    curriculum = ctx.providerStatus.mode === "mock" ? "fixture" : "generated";
    message =
      curriculum === "fixture"
        ? "Recognised the authored sample lecture. Loaded its fixture curriculum as an editable draft."
        : plan.ok && plan.parts.length > 1
          ? `Draft curriculum generated from ${plan.parts.length} parts of this long PDF (pages ${plan.parts.map((x) => `${x.firstPage}-${x.lastPage}`).join(", ")}). Review every objective before approving.`
          : "Draft curriculum generated. Review every objective before approving.";
  } else {
    curriculum = "manual_required";
    message = "Offline mode cannot generate a curriculum for this file. Text was extracted; add objectives manually.";
  }
  const transcribedCount = [...transcribed.values()].filter((t) => t.legible).length;
  return {
    courseId,
    sourceId,
    reused: false,
    curriculum,
    message: transcribedCount > 0 ? `${message!} ${transcribedCount} scanned page${transcribedCount === 1 ? " was" : "s were"} read from images by the AI; check their text.` : message!,
    pages: pages.map((p) => ({
      page: p.pageNumber,
      lowTextWarning: p.lowTextWarning,
      charCount: p.text.replace(/\s/g, "").length,
      transcribed: !!transcribed.get(p.pageNumber)?.legible,
    })),
  };
}

// ---------------------------------------------------------------- draft edits

export const draftPatchSchema = z.strictObject({
  courseTitle: z.string().trim().min(1).max(200).optional(),
  units: z
    .array(
      z.strictObject({
        unitId: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        objective: z.string().trim().min(1).max(300).optional(),
        delete: z.boolean().optional(),
        skills: z
          .array(
            z.strictObject({
              skillId: z.string(),
              objective: z.string().trim().min(1).max(300).optional(),
              required: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .max(50)
    .default([]),
  /** Approved imported courses only: a material change creates a new unit version with new skill ids and fresh evidence. */
  revisions: z
    .array(
      z.strictObject({
        unitId: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        objective: z.string().trim().min(1).max(300),
      }),
    )
    .max(20)
    .default([]),
  addUnits: z
    .array(
      z.strictObject({
        topicTitle: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        objective: z.string().trim().min(1).max(300),
        sourcePages: z.array(z.number().int().positive()).min(1).max(20),
      }),
    )
    .max(20)
    .default([]),
});
export type DraftPatch = z.infer<typeof draftPatchSchema>;
export type DraftPatchInput = z.input<typeof draftPatchSchema>;

function coursePageCount(ctx: AppContext, courseId: string): number {
  const counts = ctx.db.prepare("SELECT MAX(page_count) AS n FROM sources WHERE course_id = ?").get(courseId) as { n: number | null };
  return counts.n ?? 0;
}

export function patchDraft(ctx: AppContext, courseId: string, input: DraftPatchInput) {
  const patch = draftPatchSchema.parse(input);
  const course = getCourse(ctx.db, courseId);
  if (!course) throw notFound("Course");
  if (course.isDemo) throw new AppError("frozen", "The demo course cannot be edited.");
  if (course.status !== "draft") {
    if (patch.units.length > 0 || patch.addUnits.length > 0 || patch.courseTitle) {
      throw new AppError(
        "frozen",
        "Approved objectives are frozen. To change one, revise it: the revision becomes a new unit version with fresh evidence.",
      );
    }
    reviseUnits(ctx, courseId, patch.revisions);
    return;
  }
  if (patch.revisions.length > 0) throw new AppError("validation", "Revisions apply to approved courses; edit the draft directly.");
  const pageCount = coursePageCount(ctx, courseId);
  ctx.db.transaction(() => {
    if (patch.courseTitle) ctx.db.prepare("UPDATE courses SET title = ? WHERE id = ?").run(patch.courseTitle, courseId);
    const topicIds = new Set(listTopics(ctx.db, courseId).map((t) => t.id));
    for (const u of patch.units) {
      const unit = getUnit(ctx.db, u.unitId);
      if (!unit || !topicIds.has(unit.topicId)) throw notFound(`Unit ${u.unitId}`);
      const skills = listSkillsForUnit(ctx.db, unit.id);
      if (skills.some((s) => skillUsedInSession(ctx.db, s.id))) {
        throw new AppError("frozen", `"${unit.title}" has been used in a session; its objectives are frozen.`);
      }
      if (u.delete) {
        deleteUnit(ctx.db, unit.id);
        continue;
      }
      updateUnit(ctx.db, unit.id, { title: u.title, objective: u.objective });
      for (const s of u.skills ?? []) {
        if (!skills.some((x) => x.id === s.skillId)) throw notFound(`Skill ${s.skillId}`);
        updateSkill(ctx.db, s.skillId, { objective: s.objective, required: s.required });
      }
    }
    for (const add of patch.addUnits) {
      for (const p of add.sourcePages) {
        if (p > pageCount) throw new AppError("validation", `Page ${p} does not exist (the PDF has ${pageCount} pages).`);
      }
      const topic = listTopics(ctx.db, courseId).find((t) => t.title === add.topicTitle);
      const topicId = topic?.id ?? insertTopic(ctx.db, { courseId, title: add.topicTitle, position: listTopics(ctx.db, courseId).length + 1 });
      const position = listUnits(ctx.db, topicId).length;
      const unitId = insertUnit(ctx.db, {
        topicId,
        title: add.title,
        objective: add.objective,
        approvalStatus: "draft",
        sourceRefs: add.sourcePages.map((page) => ({ page })),
        position,
      });
      insertSkill(ctx.db, { unitId, objective: add.objective, required: true, transferRequired: true, position: 0 });
    }
    // Remove topics left empty by deletions.
    for (const t of listTopics(ctx.db, courseId)) {
      if (listUnits(ctx.db, t.id, true).length === 0) ctx.db.prepare("DELETE FROM topics WHERE id = ?").run(t.id);
    }
  })();
}

/**
 * MVP versioning: a revised objective duplicates the unit and its skills under new ids (version + 1) and marks the old
 * unit superseded. Old evidence stays attached to the old skill ids; the new version starts unassessed.
 */
function reviseUnits(ctx: AppContext, courseId: string, revisions: DraftPatch["revisions"]) {
  const topicIds = new Set(listTopics(ctx.db, courseId).map((t) => t.id));
  ctx.db.transaction(() => {
    for (const r of revisions) {
      const unit = getUnit(ctx.db, r.unitId);
      if (!unit || !topicIds.has(unit.topicId) || unit.approvalStatus !== "approved") throw notFound(`Approved unit ${r.unitId}`);
      const newUnitId = insertUnit(ctx.db, {
        topicId: unit.topicId,
        title: r.title ?? unit.title,
        objective: r.objective,
        version: unit.version + 1,
        approvalStatus: "approved",
        sourceRefs: unit.sourceRefs,
        explanation: null,
        workedExample: null,
        position: unit.position,
        supersedesUnitId: unit.id,
      });
      const skills = listSkillsForUnit(ctx.db, unit.id);
      skills.forEach((s, i) =>
        insertSkill(ctx.db, {
          unitId: newUnitId,
          objective: skills.length === 1 ? r.objective : s.objective,
          required: s.required,
          transferRequired: s.transferRequired,
          version: s.version + 1,
          position: i,
        }),
      );
      updateUnit(ctx.db, unit.id, { approvalStatus: "superseded" });
    }
  })();
}

export function approveCourse(ctx: AppContext, courseId: string) {
  const course = getCourse(ctx.db, courseId);
  if (!course) throw notFound("Course");
  if (course.status === "approved") return { alreadyApproved: true };
  const topics = listTopics(ctx.db, courseId);
  const units = topics.flatMap((t) => listUnits(ctx.db, t.id));
  if (units.length === 0) throw new AppError("validation", "Add at least one objective before approving.");
  const pageCount = coursePageCount(ctx, courseId);
  for (const u of units) {
    if (!u.objective.trim()) throw new AppError("validation", `"${u.title}" has an empty objective.`);
    for (const r of u.sourceRefs) if (r.page < 1 || r.page > pageCount) throw new AppError("validation", `"${u.title}" cites invalid page ${r.page}.`);
    if (listSkillsForUnit(ctx.db, u.id).length === 0) throw new AppError("validation", `"${u.title}" has no skills.`);
  }
  ctx.db.transaction(() => {
    for (const u of units) updateUnit(ctx.db, u.id, { approvalStatus: "approved" });
    setCourseStatus(ctx.db, courseId, "approved");
  })();
  return { alreadyApproved: false };
}

// ---------------------------------------------------------------- source serving

/**
 * Serving the whole PDF exposes the whole lecture: first record a source exposure for every active session in
 * the course, affecting all skills mapped to the source's pages (here: all skills in each session's topic).
 */
export function openSourceFile(ctx: AppContext, dataDir: string, sourceId: string): { bytes: Buffer; name: string; exposedSessions: number } {
  if (!/^[0-9a-f-]{36}$|^demo-[a-z0-9-]+$/.test(sourceId)) throw notFound("Source");
  const source = getSource(ctx.db, sourceId);
  if (!source || !source.courseId || source.status !== "extracted") throw notFound("Source");
  const file = path.join(dataDir, "uploads", path.basename(source.storedPath));
  if (!existsSync(file)) throw notFound("Source file");
  const sessions = listActiveSessionsForCourse(ctx.db, source.courseId);
  ctx.db.transaction(() => {
    for (const s of sessions) {
      const affected = listSkillsForTopic(ctx.db, s.topicId).map((k) => k.id);
      insertExposure(ctx.db, {
        sessionId: s.id,
        kind: "source",
        affectedSkillIds: affected,
        contentRef: `source-file:${source.id}`,
        recordedAt: ctx.clock.now(),
      });
    }
  })();
  return { bytes: readFileSync(file), name: source.originalName, exposedSessions: sessions.length };
}
