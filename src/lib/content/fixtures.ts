import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  curriculumFixtureSchema,
  lectureFixtureSchema,
  pacerContextsFixtureSchema,
  pacerDevCasesSchema,
  questionBankSchema,
  replayFixtureSchema,
  type CurriculumFixture,
  type LectureFixture,
  type PacerContextsFixture,
  type PacerDevCases,
  type QuestionBank,
  type ReplayFixture,
} from "./schemas";

export const FIXTURES_DIR = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "fixtures");
export const SAMPLE_PDF_PATH = path.join(FIXTURES_DIR, "sample-lecture.pdf");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

let cache: {
  curriculum: CurriculumFixture;
  lecture: LectureFixture;
  bank: QuestionBank;
  replay: ReplayFixture;
  pacer: PacerContextsFixture;
} | null = null;

/** Loads and validates the authored fixtures. Throws on any schema violation. */
export function loadFixtures() {
  if (!cache) {
    cache = {
      curriculum: curriculumFixtureSchema.parse(readJson("curriculum.json")),
      lecture: lectureFixtureSchema.parse(readJson("lecture.json")),
      bank: questionBankSchema.parse(readJson("questions.json")),
      replay: replayFixtureSchema.parse(readJson("historical-replay.json")),
      pacer: pacerContextsFixtureSchema.parse(readJson("pacer/contexts.json")),
    };
  }
  return cache;
}

let devCache: PacerDevCases | null = null;

/** Authored PACER development cases (F01-F12 and invalid service responses). */
export function loadPacerDevCases(): PacerDevCases {
  devCache ??= pacerDevCasesSchema.parse(readJson("pacer/dev-cases.json"));
  return devCache;
}
