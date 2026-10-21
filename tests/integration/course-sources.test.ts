import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { MIGRATIONS_DIR, runMigrations } from "../../src/lib/db/migrate";
import {
  citePages,
  getQuestion,
  getUnit,
  insertSource,
  listSourcesForCourse,
  pagesForRefs,
  replaceSourcePages,
} from "../../src/lib/db/repo";
import { sourceTextFor } from "../../src/lib/services/assessments";
import { approveCourse, importPdf, patchDraft } from "../../src/lib/services/imports";
import { unitPages } from "../../src/lib/services/questionDrafts";
import { DEMO_COURSE_ID, DEMO_SOURCE_ID } from "../../src/lib/services/seed";
import { getSessionView, reveal, startSession } from "../../src/lib/services/sessions";
import { getCourseView } from "../../src/lib/services/views";
import type { AppContext } from "../../src/lib/services/context";
import { createTestContext } from "../helpers";

const BCE = "demo-topic-bce";

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

/** A second lecture in the demo course whose pages reuse the demo lecture's page numbers. */
function addSecondLecture(ctx: AppContext, role: "lecture" | "course_document" = "lecture"): string {
  const id = insertSource(ctx.db, {
    courseId: DEMO_COURSE_ID,
    sha256: "second",
    originalName: "lecture-2.pdf",
    label: "Lecture 2",
    storedPath: "lecture-2.pdf",
    pageCount: 6,
    status: "extracted",
    error: null,
    createdAt: ctx.clock.now() + 1,
    role,
  });
  replaceSourcePages(
    ctx.db,
    id,
    Array.from({ length: 6 }, (_, i) => ({ pageNumber: i + 1, text: `SECOND LECTURE page ${i + 1}`, lowTextWarning: false })),
  );
  return id;
}

describe("phase A: citations name their source", () => {
  it("migration 015 adds a source role and turns {page} citations into {sourceId, page} for units and questions", () => {
    // Build a database at migration 014 with old-format citations, then apply the remaining migrations.
    const dir = mkdtempSync(path.join(os.tmpdir(), "proximal-mig-"));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < "015")) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
      const db = new Database(":memory:");
      runMigrations(db, dir);
      db.exec(`
        INSERT INTO courses (id, title, is_demo, status, created_at) VALUES ('c1', 'Course', 0, 'draft', 1), ('c2', 'No source', 0, 'draft', 1);
        INSERT INTO sources (id, course_id, sha256, original_name, stored_path, page_count, status, created_at)
          VALUES ('src1', 'c1', 'h', 'l.pdf', 'l.pdf', 9, 'extracted', 1);
        INSERT INTO topics (id, course_id, title, position) VALUES ('t1', 'c1', 'T', 1), ('t2', 'c2', 'T', 1);
        INSERT INTO units (id, topic_id, title, objective, approval_status, source_refs_json)
          VALUES ('u1', 't1', 'U', 'O', 'draft', '[{"page":2},{"page":7}]'), ('u2', 't1', 'U2', 'O', 'draft', '[]'),
                 ('u3', 't2', 'U3', 'O', 'draft', '[{"page":1}]');
        INSERT INTO skills (id, unit_id, objective) VALUES ('k1', 'u1', 'S');
        INSERT INTO questions (id, skill_id, version, family_id, is_transfer, task_type, prompt, reference_json, rubric_json, hints_json,
                               source_refs_json, reveal_skill_ids_json, status)
          VALUES ('q1', 'k1', 1, 'f', 0, 'explain', 'P', '{}', '{}', '[]', '[{"page":7}]', '[]', 'authored_fixture');
      `);
      runMigrations(db, MIGRATIONS_DIR);
      const refs = (table: string, id: string) => JSON.parse((db.prepare(`SELECT source_refs_json AS r FROM ${table} WHERE id = ?`).get(id) as { r: string }).r);
      expect(refs("units", "u1")).toEqual([{ sourceId: "src1", page: 2 }, { sourceId: "src1", page: 7 }]);
      expect(refs("units", "u2")).toEqual([]);
      expect(refs("units", "u3")).toEqual([{ page: 1 }]); // a course with no source is left as it was
      expect(refs("questions", "q1")).toEqual([{ sourceId: "src1", page: 7 }]);
      expect(db.prepare("SELECT role FROM sources WHERE id = 'src1'").get()).toEqual({ role: "lecture" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every stored citation names its source after seeding and after an import", async () => {
    const { ctx, dir } = await setup();
    await importPdf(ctx, dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
    const rows = ctx.db.prepare("SELECT source_refs_json AS r FROM units UNION ALL SELECT source_refs_json FROM questions").all() as { r: string }[];
    const all = rows.flatMap((x) => JSON.parse(x.r) as { sourceId?: string; page: number }[]);
    expect(all.length).toBeGreaterThan(10);
    expect(all.every((c) => typeof c.sourceId === "string" && c.sourceId.length > 0)).toBe(true);
    expect(getUnit(ctx.db, "U4")!.sourceRefs).toEqual([{ sourceId: DEMO_SOURCE_ID, page: 4 }]);
    expect(getQuestion(ctx.db, "S4-A")!.sourceRefs).toEqual([{ sourceId: DEMO_SOURCE_ID, page: 4 }]);
  });

  it("two lectures with the same page numbers: each feature gets only the page it cites", async () => {
    const { ctx } = await setup();
    const second = addSecondLecture(ctx);
    const unit = getUnit(ctx.db, "U4")!;

    const pages = pagesForRefs(ctx.db, DEMO_COURSE_ID, unit.sourceRefs);
    expect(pages.map((p) => [p.sourceId, p.page])).toEqual([[DEMO_SOURCE_ID, 4]]);
    expect(pages[0].text).not.toContain("SECOND LECTURE");

    // Question drafting, grading context and in-session source pages.
    expect(unitPages(ctx, DEMO_COURSE_ID, unit).map((p) => p.text).join(" ")).not.toContain("SECOND LECTURE");
    expect(sourceTextFor(ctx, DEMO_COURSE_ID, getQuestion(ctx.db, "S4-A")!)).not.toContain("SECOND LECTURE");
    const { sessionId } = startSession(ctx, { topicId: BCE, mode: "review", skillIds: ["S4"] });
    const sq = getSessionView(ctx, sessionId).current!.sessionQuestionId;
    const shown = await reveal(ctx, sessionId, { kind: "source", sessionQuestionId: sq });
    const shownPages = (shown.content as { pages: { sourceId: string; page: number; text: string }[] }).pages;
    expect(shownPages.map((p) => [p.sourceId, p.page])).toEqual([[DEMO_SOURCE_ID, 4]]);

    // A citation of the second lecture resolves to the second lecture only.
    expect(pagesForRefs(ctx.db, DEMO_COURSE_ID, [{ sourceId: second, page: 4 }]).map((p) => p.text)).toEqual(["SECOND LECTURE page 4"]);
    // Citations of another course's source are ignored.
    expect(pagesForRefs(ctx.db, "some-other-course", unit.sourceRefs)).toEqual([]);

    // The course view links each citation to its own source.
    const view = getCourseView(ctx, DEMO_COURSE_ID);
    expect(view.topics.flatMap((t) => t.units).find((u) => u.id === "U4")!.sourceRefs).toEqual([{ sourceId: DEMO_SOURCE_ID, page: 4 }]);
  });

  it("a citation recorded without a sourceId (pre-015 snapshot) still means the course's oldest lecture", async () => {
    const { ctx } = await setup();
    addSecondLecture(ctx);
    const pages = pagesForRefs(ctx.db, DEMO_COURSE_ID, [{ page: 4 }]);
    expect(pages.map((p) => [p.sourceId, p.page])).toEqual([[DEMO_SOURCE_ID, 4]]);
    expect(listSourcesForCourse(ctx.db, DEMO_COURSE_ID)[0].id).toBe(DEMO_SOURCE_ID);
  });

  it("citePages takes each page's source from the unit's citations", () => {
    const unitRefs = [
      { sourceId: "a", page: 3 },
      { sourceId: "b", page: 5 },
    ];
    expect(citePages(unitRefs, [5, 3, 9], "fallback")).toEqual([
      { sourceId: "b", page: 5 },
      { sourceId: "a", page: 3 },
      { sourceId: "fallback", page: 9 },
    ]);
    expect(citePages([], [2], null)).toEqual([{ page: 2 }]);
  });

  it("manual objectives cite the course's lecture, and approval rejects citations outside it", async () => {
    const { ctx, dir } = await setup();
    const res = await importPdf(ctx, dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
    patchDraft(ctx, res.courseId, { units: [], addUnits: [{ topicTitle: "Extra", title: "Manual", objective: "Explain something", sourcePages: [2] }] });
    const manual = getCourseView(ctx, res.courseId).topics.flatMap((t) => t.units).find((u) => u.title === "Manual")!;
    expect(manual.sourceRefs).toEqual([{ sourceId: res.sourceId, page: 2 }]);
    expect(() =>
      patchDraft(ctx, res.courseId, { units: [], addUnits: [{ topicTitle: "Extra", title: "Bad", objective: "Bad", sourcePages: [7] }] }),
    ).toThrow(/does not exist/);

    // A citation of a course document, or of a page its source does not have, cannot be approved.
    const doc = insertSource(ctx.db, {
      courseId: res.courseId, sha256: "doc", originalName: "syllabus.pdf", label: "Syllabus", storedPath: "s.pdf",
      pageCount: 2, status: "extracted", error: null, createdAt: ctx.clock.now() + 1, role: "course_document",
    });
    ctx.db.prepare("UPDATE units SET source_refs_json = ? WHERE id = ?").run(JSON.stringify([{ sourceId: doc, page: 1 }]), manual.id);
    expect(() => approveCourse(ctx, res.courseId)).toThrow(/cites invalid page 1/);
    ctx.db.prepare("UPDATE units SET source_refs_json = ? WHERE id = ?").run(JSON.stringify([{ sourceId: res.sourceId, page: 99 }]), manual.id);
    expect(() => approveCourse(ctx, res.courseId)).toThrow(/cites invalid page 99/);
    ctx.db.prepare("UPDATE units SET source_refs_json = ? WHERE id = ?").run(JSON.stringify([{ sourceId: res.sourceId, page: 2 }]), manual.id);
    expect(approveCourse(ctx, res.courseId)).toEqual({ alreadyApproved: false });
  });
});
