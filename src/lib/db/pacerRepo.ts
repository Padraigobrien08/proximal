// PACER repositories. Parameterised SQL only.
import type Database from "better-sqlite3";
import type { ActivityMaterial, FrozenActivity, TemplateId } from "../pacer/registry";
import type { MemoryRequirement, PacerType } from "../pacer/taxonomy";
import type { ChunkKind } from "../pacer/validation";
import { newId } from "./repo";

type DB = Database.Database;

// ---------------------------------------------------------------- contexts

export interface AuxChunk {
  chunkId: string;
  kind: ChunkKind;
  label: string;
  text: string;
}

export interface PacerContextRow {
  skillId: string;
  contextVersion: number;
  learningGoal: string | null;
  memoryRequirement: MemoryRequirement;
  auxChunks: AuxChunk[];
  material: ActivityMaterial;
  updatedAt: number;
}

export function getPacerContext(db: DB, skillId: string): PacerContextRow | null {
  const r = db.prepare("SELECT * FROM pacer_contexts WHERE skill_id = ?").get(skillId) as
    | {
        skill_id: string;
        context_version: number;
        learning_goal: string | null;
        memory_requirement: MemoryRequirement;
        aux_chunks_json: string;
        material_json: string;
        updated_at: number;
      }
    | undefined;
  if (!r) return null;
  return {
    skillId: r.skill_id,
    contextVersion: r.context_version,
    learningGoal: r.learning_goal,
    memoryRequirement: r.memory_requirement,
    auxChunks: JSON.parse(r.aux_chunks_json),
    material: JSON.parse(r.material_json),
    updatedAt: r.updated_at,
  };
}

export function upsertPacerContext(db: DB, c: PacerContextRow) {
  db.prepare(
    `INSERT INTO pacer_contexts (skill_id, context_version, learning_goal, memory_requirement, aux_chunks_json, material_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (skill_id) DO UPDATE SET context_version = excluded.context_version, learning_goal = excluded.learning_goal,
       memory_requirement = excluded.memory_requirement, aux_chunks_json = excluded.aux_chunks_json,
       material_json = excluded.material_json, updated_at = excluded.updated_at`,
  ).run(c.skillId, c.contextVersion, c.learningGoal, c.memoryRequirement, JSON.stringify(c.auxChunks), JSON.stringify(c.material), c.updatedAt);
}

// ---------------------------------------------------------------- proposals

export type ProposalKind = "suggestion" | "abstain" | "invalid" | "error";

export interface ProposalRow {
  id: string;
  skillId: string;
  skillVersion: number;
  contextHash: string;
  cacheKey: string;
  taxonomyVersion: string;
  promptVersion: string;
  routingVersion: string;
  providerMode: "mock" | "live";
  providerModel: string | null;
  kind: ProposalKind;
  /** suggestion/abstain: the validated proposal. invalid: { problems }. error: { code, message }. */
  result: Record<string, unknown>;
  createdAt: number;
}

interface RawProposal {
  id: string;
  skill_id: string;
  skill_version: number;
  context_hash: string;
  cache_key: string;
  taxonomy_version: string;
  prompt_version: string;
  routing_version: string;
  provider_mode: "mock" | "live";
  provider_model: string | null;
  kind: ProposalKind;
  result_json: string;
  created_at: number;
}
const mapProposal = (r: RawProposal): ProposalRow => ({
  id: r.id,
  skillId: r.skill_id,
  skillVersion: r.skill_version,
  contextHash: r.context_hash,
  cacheKey: r.cache_key,
  taxonomyVersion: r.taxonomy_version,
  promptVersion: r.prompt_version,
  routingVersion: r.routing_version,
  providerMode: r.provider_mode,
  providerModel: r.provider_model,
  kind: r.kind,
  result: JSON.parse(r.result_json),
  createdAt: r.created_at,
});

export function insertProposal(db: DB, p: Omit<ProposalRow, "id">): ProposalRow {
  const id = newId();
  db.prepare(
    `INSERT INTO pacer_proposals (id, skill_id, skill_version, context_hash, cache_key, taxonomy_version, prompt_version, routing_version,
       provider_mode, provider_model, kind, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    p.skillId,
    p.skillVersion,
    p.contextHash,
    p.cacheKey,
    p.taxonomyVersion,
    p.promptVersion,
    p.routingVersion,
    p.providerMode,
    p.providerModel,
    p.kind,
    JSON.stringify(p.result),
    p.createdAt,
  );
  return { id, ...p };
}

export function getProposal(db: DB, id: string): ProposalRow | null {
  const r = db.prepare("SELECT * FROM pacer_proposals WHERE id = ?").get(id) as RawProposal | undefined;
  return r ? mapProposal(r) : null;
}

/** Most recent proposal row for a skill (any kind). rowid breaks ties within one millisecond. */
export function latestProposal(db: DB, skillId: string): ProposalRow | null {
  const r = db.prepare("SELECT * FROM pacer_proposals WHERE skill_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(skillId) as
    | RawProposal
    | undefined;
  return r ? mapProposal(r) : null;
}

/** Reusable valid proposal for an unchanged request (same context, prompt and provider/model). */
export function cachedProposal(db: DB, cacheKey: string): ProposalRow | null {
  const r = db
    .prepare("SELECT * FROM pacer_proposals WHERE cache_key = ? AND kind IN ('suggestion', 'abstain') ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(cacheKey) as RawProposal | undefined;
  return r ? mapProposal(r) : null;
}

export function countProposals(db: DB, skillId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pacer_proposals WHERE skill_id = ?").get(skillId) as { n: number }).n;
}

// ---------------------------------------------------------------- decisions

export interface DecisionRow {
  id: string;
  proposalId: string | null;
  skillId: string;
  skillVersion: number;
  contextHash: string;
  status: "accepted" | "edited" | "dismissed";
  origin: "suggestion" | "manual";
  primaryType: PacerType | null;
  secondary: PacerType[];
  reason: string | null;
  isEffective: boolean;
  createdAt: number;
}

interface RawDecision {
  id: string;
  proposal_id: string | null;
  skill_id: string;
  skill_version: number;
  context_hash: string;
  status: DecisionRow["status"];
  origin: DecisionRow["origin"];
  primary_type: PacerType | null;
  secondary_json: string;
  reason: string | null;
  is_effective: number;
  created_at: number;
}
const mapDecision = (r: RawDecision): DecisionRow => ({
  id: r.id,
  proposalId: r.proposal_id,
  skillId: r.skill_id,
  skillVersion: r.skill_version,
  contextHash: r.context_hash,
  status: r.status,
  origin: r.origin,
  primaryType: r.primary_type,
  secondary: JSON.parse(r.secondary_json),
  reason: r.reason,
  isEffective: !!r.is_effective,
  createdAt: r.created_at,
});

export function effectiveDecision(db: DB, skillId: string): DecisionRow | null {
  const r = db.prepare("SELECT * FROM pacer_decisions WHERE skill_id = ? AND is_effective = 1").get(skillId) as RawDecision | undefined;
  return r ? mapDecision(r) : null;
}

export function getDecision(db: DB, id: string): DecisionRow | null {
  const r = db.prepare("SELECT * FROM pacer_decisions WHERE id = ?").get(id) as RawDecision | undefined;
  return r ? mapDecision(r) : null;
}

export function listDecisions(db: DB, skillId: string): DecisionRow[] {
  return (db.prepare("SELECT * FROM pacer_decisions WHERE skill_id = ? ORDER BY created_at, rowid").all(skillId) as RawDecision[]).map(mapDecision);
}

/** Append a decision and make it the effective one. Must run inside a transaction. */
export function appendDecision(db: DB, d: Omit<DecisionRow, "id" | "isEffective">): DecisionRow {
  db.prepare("UPDATE pacer_decisions SET is_effective = 0 WHERE skill_id = ? AND is_effective = 1").run(d.skillId);
  const id = newId();
  db.prepare(
    `INSERT INTO pacer_decisions (id, proposal_id, skill_id, skill_version, context_hash, status, origin, primary_type, secondary_json, reason, is_effective, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, d.proposalId, d.skillId, d.skillVersion, d.contextHash, d.status, d.origin, d.primaryType, JSON.stringify(d.secondary), d.reason, d.createdAt);
  return { id, ...d, isEffective: true };
}

// ---------------------------------------------------------------- activities and responses

export type ActivityStatus = "open" | "teach" | "completed" | "skipped" | "unavailable";

export interface ActivityRow {
  id: string;
  sessionId: string;
  skillId: string;
  skillVersion: number;
  decisionId: string | null;
  templateId: TemplateId | "none";
  templateVersion: number;
  role: "primary" | "secondary";
  frozen: FrozenActivity | { label: string; pacerType: PacerType; note: string };
  ordinal: number;
  status: ActivityStatus;
  stepIndex: number;
  createdAt: number;
}

interface RawActivity {
  id: string;
  session_id: string;
  skill_id: string;
  skill_version: number;
  decision_id: string | null;
  template_id: ActivityRow["templateId"];
  template_version: number;
  role: ActivityRow["role"];
  frozen_json: string;
  ordinal: number;
  status: ActivityStatus;
  step_index: number;
  created_at: number;
}
const mapActivity = (r: RawActivity): ActivityRow => ({
  id: r.id,
  sessionId: r.session_id,
  skillId: r.skill_id,
  skillVersion: r.skill_version,
  decisionId: r.decision_id,
  templateId: r.template_id,
  templateVersion: r.template_version,
  role: r.role,
  frozen: JSON.parse(r.frozen_json),
  ordinal: r.ordinal,
  status: r.status,
  stepIndex: r.step_index,
  createdAt: r.created_at,
});

export function insertActivity(db: DB, a: Omit<ActivityRow, "id">): ActivityRow {
  const id = newId();
  db.prepare(
    `INSERT INTO pacer_activities (id, session_id, skill_id, skill_version, decision_id, template_id, template_version, role, frozen_json, ordinal, status, step_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    a.sessionId,
    a.skillId,
    a.skillVersion,
    a.decisionId,
    a.templateId,
    a.templateVersion,
    a.role,
    JSON.stringify(a.frozen),
    a.ordinal,
    a.status,
    a.stepIndex,
    a.createdAt,
  );
  return { id, ...a };
}

export function listActivities(db: DB, sessionId: string): ActivityRow[] {
  return (db.prepare("SELECT * FROM pacer_activities WHERE session_id = ? ORDER BY ordinal").all(sessionId) as RawActivity[]).map(mapActivity);
}

export function getActivity(db: DB, id: string): ActivityRow | null {
  const r = db.prepare("SELECT * FROM pacer_activities WHERE id = ?").get(id) as RawActivity | undefined;
  return r ? mapActivity(r) : null;
}

export function updateActivity(db: DB, id: string, patch: { status: ActivityStatus; stepIndex: number }) {
  db.prepare("UPDATE pacer_activities SET status = ?, step_index = ? WHERE id = ?").run(patch.status, patch.stepIndex, id);
}

export interface ResponseRow {
  id: string;
  activityId: string;
  sessionId: string;
  submissionKey: string;
  stepIndex: number;
  text: string;
  status: "submitted";
  tutorFeedback: string | null;
  submittedAt: number;
}

interface RawResponse {
  id: string;
  activity_id: string;
  session_id: string;
  submission_key: string;
  step_index: number;
  response_text: string;
  status: "submitted";
  tutor_feedback: string | null;
  submitted_at: number;
}
const mapResponse = (r: RawResponse): ResponseRow => ({
  id: r.id,
  activityId: r.activity_id,
  sessionId: r.session_id,
  submissionKey: r.submission_key,
  stepIndex: r.step_index,
  text: r.response_text,
  status: r.status,
  tutorFeedback: r.tutor_feedback,
  submittedAt: r.submitted_at,
});

export function insertResponse(db: DB, r: Omit<ResponseRow, "id" | "status" | "tutorFeedback">): ResponseRow {
  const id = newId();
  db.prepare(
    `INSERT INTO pacer_responses (id, activity_id, session_id, submission_key, step_index, response_text, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, r.activityId, r.sessionId, r.submissionKey, r.stepIndex, r.text, r.submittedAt);
  return { id, ...r, status: "submitted", tutorFeedback: null };
}

export function getResponseByKey(db: DB, sessionId: string, key: string): ResponseRow | null {
  const r = db.prepare("SELECT * FROM pacer_responses WHERE session_id = ? AND submission_key = ?").get(sessionId, key) as RawResponse | undefined;
  return r ? mapResponse(r) : null;
}

export function listResponses(db: DB, activityId: string): ResponseRow[] {
  return (db.prepare("SELECT * FROM pacer_responses WHERE activity_id = ? ORDER BY step_index").all(activityId) as RawResponse[]).map(mapResponse);
}
