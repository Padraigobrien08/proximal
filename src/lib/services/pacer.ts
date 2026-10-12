// PACER classification, review and learning activities (docs/proximal/PACER_FEATURE_SPEC.md).
// Boundaries: classification is a learning recommendation. Nothing here writes attempts, assessments or review states,
// so activity completion can never create a pass, independent evidence or a schedule change. Exposure rows are the
// only shared records written, and only before answer-revealing content is returned.
import { vendorName } from "../domain/labels";
import {
  getCourse,
  getSkill,
  getTopic,
  getUnit,
  insertExposure,
  listExposures,
  listQuestionsForSkill,
  listSkillsForTopic,
  listSourcePages,
  listSourcesForCourse,
  type SkillRow,
  type UnitRow,
} from "../db/repo";
import {
  appendDecision,
  cachedProposal,
  effectiveDecision,
  getActivity,
  getPacerContext,
  getProposal,
  getResponseByKey,
  insertActivity,
  insertProposal,
  insertResponse,
  latestProposal,
  listActivities,
  listResponses,
  updateActivity,
  type ActivityRow,
  type DecisionRow,
  type ProposalRow,
} from "../db/pacerRepo";
import { PACER_PROMPT_VERSION } from "../llm/prompts";
import { OFFLINE_PACER_MESSAGE, ProviderError } from "../llm/types";
import {
  freezeActivity,
  routeClassification,
  TEMPLATE_LABEL,
  type FrozenActivity,
  type Route,
  type RoutingFacts,
} from "../pacer/registry";
import {
  ABSTAIN_TEXT,
  mixedText,
  PACER_LABEL,
  PACER_ROUTING_VERSION,
  PACER_TAXONOMY_VERSION,
  type AbstainReason,
  type PacerType,
} from "../pacer/taxonomy";
import {
  cacheKey,
  checkLimits,
  contextHash,
  planBatches,
  normaliseWs,
  validateBatch,
  validateSelection,
  type ClassificationProposal,
  type PacerChunk,
  type PacerObjectiveInput,
} from "../pacer/validation";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";

export const OFFLINE_PROMPT_VERSION = "pacer-offline-fixture-v1";
export const MAX_RESPONSE_CHARS = 4000;
export const MAX_REASON_CHARS = 300;

// ---------------------------------------------------------------- input

type TopicSkill = SkillRow & { unit: UnitRow };

/** Approved source chunks for a unit's pages, plus authored auxiliary contexts. Whitespace-normalised. */
function chunksFor(ctx: AppContext, courseId: string, unit: UnitRow, aux: { chunkId: string; kind: PacerChunk["kind"]; label: string; text: string }[]): PacerChunk[] {
  const sources = listSourcesForCourse(ctx.db, courseId).filter((s) => s.status === "extracted");
  const pages = new Set(unit.sourceRefs.map((r) => r.page));
  const out: PacerChunk[] = [];
  sources.forEach((src, i) => {
    for (const p of listSourcePages(ctx.db, src.id)) {
      if (!pages.has(p.pageNumber)) continue;
      out.push({
        chunkId: sources.length > 1 ? `s${i + 1}p${p.pageNumber}` : `p${p.pageNumber}`,
        kind: "page",
        label: `${src.label ?? src.originalName}, PDF page ${p.pageNumber}${p.lowTextWarning ? " (low-text warning: extraction may be unreliable)" : ""}`,
        page: p.pageNumber,
        text: normaliseWs(p.text),
      });
    }
  });
  for (const a of aux) out.push({ chunkId: a.chunkId, kind: a.kind, label: a.label, page: null, text: normaliseWs(a.text) });
  return out;
}

/** The server builds classification input from approved persisted content only. No learner state is included. */
export function objectiveInput(ctx: AppContext, skill: TopicSkill, courseId: string): PacerObjectiveInput {
  const pc = getPacerContext(ctx.db, skill.id);
  const taskTypes = [...new Set(listQuestionsForSkill(ctx.db, skill.id).filter((q) => q.status !== "excluded").map((q) => q.taskType))];
  return {
    objectiveId: skill.id,
    objectiveVersion: skill.version,
    objective: skill.objective,
    taskTypes,
    learningGoal: pc?.learningGoal ?? null,
    memoryRequirement: pc?.memoryRequirement ?? "unspecified",
    learnerConnection: null,
    prerequisites: [],
    chunks: chunksFor(ctx, courseId, skill.unit, pc?.auxChunks ?? []),
  };
}

function providerIdentity(ctx: AppContext): { mode: "mock" | "live"; identity: string; promptVersion: string } {
  if (ctx.providerStatus.mode === "mock") return { mode: "mock", identity: "mock:offline-fixture", promptVersion: OFFLINE_PROMPT_VERSION };
  const model = ctx.providerStatus.models?.curriculum ?? ctx.provider.models?.curriculum ?? ctx.providerStatus.model ?? "unconfigured";
  return { mode: "live", identity: `${ctx.providerStatus.vendor ?? ctx.provider.vendor ?? "live"}:${model}`, promptVersion: PACER_PROMPT_VERSION };
}

function topicSkills(ctx: AppContext, topicId: string): { courseId: string; skills: TopicSkill[] } {
  const topic = getTopic(ctx.db, topicId);
  if (!topic) throw notFound("Topic");
  const course = getCourse(ctx.db, topic.courseId)!;
  if (course.status !== "approved") throw new AppError("stale_phase", "Approve this draft curriculum before classifying it.");
  return { courseId: course.id, skills: listSkillsForTopic(ctx.db, topic.id).filter((s) => s.unit.approvalStatus === "approved") };
}

// ---------------------------------------------------------------- classify

export interface ClassifyOptions {
  skillIds?: string[];
  /** Explicit regeneration. Without it an unchanged request reuses its saved proposal. */
  regenerate?: boolean;
}

/**
 * Bounded server-side batch. Returns persisted drafts (never auto-accepted). A provider error is persisted as a
 * retryable error row and never replaced by offline output; existing proposals and decisions are untouched.
 */
export async function classifyTopic(ctx: AppContext, topicId: string, opts: ClassifyOptions = {}) {
  const { courseId, skills } = topicSkills(ctx, topicId);
  let chosen = skills;
  if (opts.skillIds?.length) {
    const ids = new Set(skills.map((s) => s.id));
    for (const id of opts.skillIds) if (!ids.has(id)) throw new AppError("validation", `Skill ${id} is not in this topic.`);
    chosen = skills.filter((s) => opts.skillIds!.includes(s.id));
  }
  const inputs = chosen.map((s) => objectiveInput(ctx, s, courseId));
  const prov = providerIdentity(ctx);
  const now = ctx.clock.now();
  const keyed = inputs.map((o) => {
    const ch = contextHash(o);
    return { o, ch, key: cacheKey(ch, prov.promptVersion, prov.identity) };
  });
  const reused = new Set<string>();
  const pending = keyed.filter((k) => {
    if (opts.regenerate) return true;
    if (cachedProposal(ctx.db, k.key)) {
      reused.add(k.o.objectiveId);
      return false;
    }
    return true;
  });

  const base = (k: (typeof keyed)[number]) => ({
    skillId: k.o.objectiveId,
    skillVersion: k.o.objectiveVersion,
    contextHash: k.ch,
    cacheKey: k.key,
    taxonomyVersion: PACER_TAXONOMY_VERSION,
    routingVersion: PACER_ROUTING_VERSION,
    providerMode: prov.mode,
  });
  const byId = new Map(pending.map((k) => [k.o.objectiveId, k]));

  // Bounded requests. An objective too large on its own is reported by name and not sent; nothing is truncated.
  const { batches, tooLarge } = planBatches(pending.map((k) => k.o));
  const skipped = tooLarge.map((o) => ({
    skillId: o.objectiveId,
    message: checkLimits([o]).find((p) => p.objectiveId === o.objectiveId)?.message ?? "Too much context to classify.",
  }));
  if (skipped.length) {
    ctx.db.transaction(() => {
      for (const sk of skipped) {
        const k = byId.get(sk.skillId)!;
        insertProposal(ctx.db, { ...base(k), promptVersion: prov.promptVersion, providerModel: null, kind: "invalid", result: { problems: [`Not classified: ${sk.message}`] }, createdAt: now });
      }
    })();
  }

  let providerError: { code: string; message: string; retryable: boolean } | null = null;
  const batchProblems: string[] = [];
  let classified = 0;
  for (const batch of batches) {
    const toRun = batch.map((o) => byId.get(o.objectiveId)!);
    try {
      if (!ctx.provider.classifyPacer) throw new ProviderError("This provider cannot classify learning objectives.", "provider_unavailable", false);
      const res = await ctx.provider.classifyPacer({ objectives: batch });
      const checked = validateBatch(batch, res.results);
      batchProblems.push(...checked.batchProblems);
      const providerModel = res.meta.mode === "live" ? `${res.meta.vendor ?? "live"}:${res.meta.model}` : null;
      ctx.db.transaction(() => {
        checked.results.forEach((r, i) => {
          insertProposal(ctx.db, {
            ...base(toRun[i]),
            promptVersion: res.meta.promptVersion,
            providerModel,
            kind: r.ok ? r.proposal.kind : "invalid",
            result: r.ok ? r.proposal : { problems: [...r.problems, ...checked.batchProblems] },
            createdAt: now,
          });
        });
      })();
      classified += batch.length;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      providerError = { code: err.code, message: err.message, retryable: err.retryable };
      // This batch and every later one are recorded as retryable errors; no offline output replaces them.
      const failed = batches.slice(batches.indexOf(batch)).flat().map((o) => byId.get(o.objectiveId)!);
      ctx.db.transaction(() => {
        for (const k of failed) {
          insertProposal(ctx.db, {
            ...base(k),
            promptVersion: prov.promptVersion,
            providerModel: prov.mode === "live" ? prov.identity : null,
            kind: "error",
            result: providerError!,
            createdAt: now,
          });
        }
      })();
      break;
    }
  }
  return {
    classified,
    reused: [...reused],
    skipped,
    providerError,
    batchProblems,
    skills: chosen.map((s) => approachSummary(ctx, s, courseId)),
  };
}

// ---------------------------------------------------------------- state and summaries

export type ApproachStatus = "none" | "draft" | "accepted" | "edited" | "dismissed" | "stale" | "abstained" | "error" | "invalid";

function routingFacts(ctx: AppContext, skill: TopicSkill, hasPracticeQuestion: boolean): RoutingFacts {
  const pc = getPacerContext(ctx.db, skill.id);
  return {
    material: pc?.material ?? {},
    hasCheckedExplanation: !!skill.unit.explanation,
    hasPracticeQuestion,
    hasApprovedAnalogyChunk: (pc?.auxChunks ?? []).some((c) => c.kind === "analogy"),
    memoryRequirement: pc?.memoryRequirement ?? "unspecified",
  };
}

function hasReviewedQuestion(ctx: AppContext, skillId: string): boolean {
  return listQuestionsForSkill(ctx.db, skillId).some((q) => q.status !== "excluded");
}

function isDrafted(ctx: AppContext, p: ProposalRow): boolean {
  return !ctx.db.prepare("SELECT 1 FROM pacer_decisions WHERE proposal_id = ? LIMIT 1").get(p.id);
}

export function providerLabel(p: Pick<ProposalRow, "providerMode" | "providerModel" | "kind">): string {
  if (p.providerMode === "mock") return p.kind === "suggestion" ? "Offline authored annotation (not model inference)" : "Offline mode";
  if (!p.providerModel) return "Configured AI provider";
  const i = p.providerModel.indexOf(":");
  return `Suggested by ${vendorName(p.providerModel.slice(0, i))} (${p.providerModel.slice(i + 1)})`;
}

/** Display state for one skill. Safe: type badges and statuses only, no rationale or quotes. */
function skillState(ctx: AppContext, skill: TopicSkill, courseId: string) {
  const current = contextHash(objectiveInput(ctx, skill, courseId));
  const eff = effectiveDecision(ctx.db, skill.id);
  const stale = !!eff && (eff.contextHash !== current || eff.skillVersion !== skill.version);
  const latest = latestProposal(ctx.db, skill.id);
  const draft = latest && (latest.kind === "suggestion" || latest.kind === "abstain") && latest.contextHash === current && isDrafted(ctx, latest) ? latest : null;
  const failure = latest && (latest.kind === "error" || latest.kind === "invalid") ? latest : null;
  let status: ApproachStatus;
  if (eff && stale) status = "stale";
  else if (draft) status = draft.kind === "abstain" ? "abstained" : "draft";
  else if (eff) status = eff.status;
  else if (failure) status = failure.kind === "error" ? "error" : "invalid";
  else status = "none";
  return { current, eff, stale, draft, failure, latest, status };
}

function decisionRoute(ctx: AppContext, skill: TopicSkill, eff: DecisionRow | null, stale: boolean): Route | null {
  if (!eff || stale || eff.status === "dismissed" || !eff.primaryType) return null;
  return routeClassification(eff.primaryType, eff.secondary, routingFacts(ctx, skill, hasReviewedQuestion(ctx, skill.id)));
}

const typeBadge = (primary: PacerType, secondary: PacerType[]) => ({
  primary,
  secondary,
  primaryLabel: PACER_LABEL[primary],
  secondaryLabels: secondary.map((t) => PACER_LABEL[t]),
});

export function approachSummary(ctx: AppContext, skill: TopicSkill, courseId: string) {
  const st = skillState(ctx, skill, courseId);
  const route = decisionRoute(ctx, skill, st.eff, st.stale);
  const draftResult = st.draft?.result as ClassificationProposal | undefined;
  return {
    skillId: skill.id,
    unitId: skill.unitId,
    objective: skill.objective,
    label: skill.label ?? skill.objective,
    status: st.status,
    effective: st.eff
      ? {
          decisionId: st.eff.id,
          status: st.eff.status,
          origin: st.eff.origin,
          chosenByYou: st.eff.origin === "manual",
          ...(st.eff.primaryType ? typeBadge(st.eff.primaryType, st.eff.secondary) : { primary: null, secondary: [], primaryLabel: null, secondaryLabels: [] }),
          stale: st.stale,
        }
      : null,
    route: route
      ? {
          primaryLabel: route.primary.label,
          primaryAvailable: route.primary.templateId !== null,
          secondaryLabel: route.secondary?.label ?? null,
        }
      : null,
    draft: st.draft
      ? {
          proposalId: st.draft.id,
          kind: st.draft.kind as "suggestion" | "abstain",
          ...(draftResult?.kind === "suggestion" ? typeBadge(draftResult.primary, draftResult.secondary) : {}),
          abstainText: draftResult?.kind === "abstain" ? ABSTAIN_TEXT[draftResult.reason as AbstainReason] : null,
          providerLabel: providerLabel(st.draft),
        }
      : null,
    failure: st.failure
      ? {
          kind: st.failure.kind,
          message:
            st.failure.kind === "error"
              ? String((st.failure.result as { message?: string }).message ?? "The provider failed.")
              : String((st.failure.result as { problems?: string[] }).problems?.[0] ?? "The suggestion failed validation and was not saved as a proposal."),
        }
      : null,
  };
}

export type ApproachSummary = ReturnType<typeof approachSummary>;

export function topicApproaches(ctx: AppContext, topicId: string) {
  const topic = getTopic(ctx.db, topicId);
  if (!topic) throw notFound("Topic");
  const course = getCourse(ctx.db, topic.courseId)!;
  if (course.status !== "approved") return { available: false, skills: [] as ApproachSummary[] };
  const skills = listSkillsForTopic(ctx.db, topic.id).filter((s) => s.unit.approvalStatus === "approved");
  return { available: true, skills: skills.map((s) => approachSummary(ctx, s, course.id)) };
}

/** Short route label for the home page reason, e.g. "Connect and explain". Never a rationale. */
export function approachHint(ctx: AppContext, skillIds: string[]): string | null {
  for (const id of skillIds) {
    const skill = getSkill(ctx.db, id);
    if (!skill) continue;
    const unit = getUnit(ctx.db, skill.unitId)!;
    const topic = getTopic(ctx.db, unit.topicId)!;
    const st = skillState(ctx, { ...skill, unit }, topic.courseId);
    const route = decisionRoute(ctx, { ...skill, unit }, st.eff, st.stale);
    if (route?.primary.templateId) return route.primary.label;
  }
  return null;
}

// ---------------------------------------------------------------- details (exposure guarded)

/** Active sessions that include this skill: substantive classification detail counts as help there. */
function activeSessionsWithSkill(ctx: AppContext, skillId: string): string[] {
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT s.id FROM sessions s JOIN session_questions sq ON sq.session_id = s.id
       WHERE s.status = 'active' AND sq.skill_id = ?`,
    )
    .all(skillId) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Rationales and support quotes can teach the answer. Before returning them, an explanation exposure is committed in
 * every active session that includes the skill (whichever topic or course view asked).
 */
export function revealApproachDetails(ctx: AppContext, topicId: string, skillIds?: string[]) {
  const { courseId, skills } = topicSkills(ctx, topicId);
  const chosen = skillIds?.length ? skills.filter((s) => skillIds.includes(s.id)) : skills;
  if (skillIds?.length && chosen.length !== skillIds.length) throw new AppError("validation", "Some skills are not in this topic.");
  const now = ctx.clock.now();
  const recorded: { sessionId: string; skillId: string }[] = [];
  ctx.db.transaction(() => {
    for (const s of chosen) {
      for (const sessionId of activeSessionsWithSkill(ctx, s.id)) {
        insertExposure(ctx.db, { sessionId, kind: "explanation", affectedSkillIds: [s.id], contentRef: `pacer-detail:${s.id}`, recordedAt: now });
        recorded.push({ sessionId, skillId: s.id });
      }
    }
  })();
  return {
    exposuresRecorded: recorded.length,
    skills: chosen.map((s) => {
      const input = objectiveInput(ctx, s, courseId);
      const st = skillState(ctx, s, courseId);
      const chunkLabel = new Map(input.chunks.map((c) => [c.chunkId, c]));
      const proposalDetail = (p: ProposalRow | null) => {
        if (!p || (p.kind !== "suggestion" && p.kind !== "abstain")) return null;
        const r = p.result as ClassificationProposal;
        return {
          proposalId: p.id,
          providerLabel: providerLabel(p),
          createdAt: p.createdAt,
          ...(r.kind === "suggestion"
            ? {
                kind: "suggestion" as const,
                ...typeBadge(r.primary, r.secondary),
                mixed: mixedText(r.primary, r.secondary),
                rationale: r.rationale,
                ambiguityNote: r.ambiguityNote,
                support: r.support.map((x) =>
                  x.from === "source"
                    ? { from: x.from, quote: x.quote, where: chunkLabel.get(x.chunkId)?.label ?? x.chunkId }
                    : { from: x.from, quote: x.quote, where: x.from === "objective" ? "The objective" : "Your connection" },
                ),
              }
            : { kind: "abstain" as const, reason: r.reason, abstainText: ABSTAIN_TEXT[r.reason], message: r.message }),
        };
      };
      const effProposal = st.eff?.proposalId ? getProposal(ctx.db, st.eff.proposalId) : null;
      return {
        ...approachSummary(ctx, s, courseId),
        memoryRequirement: input.memoryRequirement,
        draftDetail: proposalDetail(st.draft),
        effectiveDetail: st.eff
          ? { reason: st.eff.reason, reasonSupplied: st.eff.reason !== null, proposal: proposalDetail(effProposal) }
          : null,
        failureDetail:
          st.failure?.kind === "invalid" ? { problems: (st.failure.result as { problems?: string[] }).problems ?? [] } : null,
      };
    }),
  };
}

// ---------------------------------------------------------------- review

export interface ReviewInput {
  action: "accept" | "edit" | "dismiss";
  /** The proposal being reviewed (accept requires it; edit/dismiss may reference it). */
  proposalId?: string | null;
  primary?: PacerType;
  secondary?: PacerType[];
  reason?: string | null;
  /** The effective decision the learner saw. A mismatch means another view changed it: no silent overwrite. */
  replacesDecisionId: string | null;
}

export function reviewClassification(ctx: AppContext, skillId: string, input: ReviewInput) {
  const skill = getSkill(ctx.db, skillId);
  if (!skill) throw notFound("Skill");
  const unit = getUnit(ctx.db, skill.unitId)!;
  const topic = getTopic(ctx.db, unit.topicId)!;
  const ts = { ...skill, unit };
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  if (reason && reason.length > MAX_REASON_CHARS) throw new AppError("validation", `Reasons are limited to ${MAX_REASON_CHARS} characters.`);

  return ctx.db.transaction(() => {
    const current = contextHash(objectiveInput(ctx, ts, topic.courseId));
    const eff = effectiveDecision(ctx.db, skillId);
    if ((eff?.id ?? null) !== input.replacesDecisionId) {
      throw new AppError("conflict", "This learning approach changed in another view. Reload to see the current choice.");
    }
    let proposal: ProposalRow | null = null;
    if (input.proposalId) {
      proposal = getProposal(ctx.db, input.proposalId);
      if (!proposal || proposal.skillId !== skillId) throw notFound("Proposal");
      if (proposal.contextHash !== current) {
        throw new AppError("stale_phase", "The source or context changed since this suggestion was made. Classify again or choose an approach yourself.");
      }
    }
    const base = { skillId, skillVersion: skill.version, contextHash: current, createdAt: ctx.clock.now() };
    if (input.action === "accept") {
      const r = proposal?.result as ClassificationProposal | undefined;
      if (!proposal || proposal.kind !== "suggestion" || r?.kind !== "suggestion") {
        throw new AppError("validation", "Only a valid suggestion can be accepted. Choose an approach yourself instead.");
      }
      return appendDecision(ctx.db, {
        ...base,
        proposalId: proposal.id,
        status: "accepted",
        origin: "suggestion",
        primaryType: r.primary,
        secondary: r.secondary,
        reason,
      });
    }
    if (input.action === "dismiss") {
      return appendDecision(ctx.db, { ...base, proposalId: proposal?.id ?? null, status: "dismissed", origin: proposal ? "suggestion" : "manual", primaryType: null, secondary: [], reason });
    }
    let sel;
    try {
      sel = validateSelection(input.primary, input.secondary ?? []);
    } catch (e) {
      throw new AppError("validation", (e as Error).message);
    }
    // A manual choice records the learner's reason (or that none was given); no grounding quotes are invented.
    return appendDecision(ctx.db, {
      ...base,
      proposalId: proposal?.id ?? null,
      status: "edited",
      origin: "manual",
      primaryType: sel.primary,
      secondary: sel.secondary,
      reason,
    });
  })();
}

/** Explicit "Accept all suggestions" for the curated bank, after each result has been displayed. */
export function acceptAllDrafts(ctx: AppContext, topicId: string, proposalIds: string[]) {
  const { courseId, skills } = topicSkills(ctx, topicId);
  const accepted: string[] = [];
  ctx.db.transaction(() => {
    for (const s of skills) {
      const st = skillState(ctx, s, courseId);
      if (!st.draft || st.draft.kind !== "suggestion" || !proposalIds.includes(st.draft.id)) continue;
      reviewClassification(ctx, s.id, { action: "accept", proposalId: st.draft.id, replacesDecisionId: st.eff?.id ?? null });
      accepted.push(s.id);
    }
  })();
  return { accepted };
}

// ---------------------------------------------------------------- learning session activities

/**
 * Freeze the effective, current, reviewed approach for each skill into a new learning session. Called inside the
 * session-start transaction. Skills without a reviewed approach keep the ordinary learning flow.
 */
export function freezeSessionActivities(ctx: AppContext, sessionId: string, courseId: string, skills: { skill: TopicSkill; hasPracticeQuestion: boolean }[]) {
  const now = ctx.clock.now();
  let ordinal = 0;
  for (const { skill, hasPracticeQuestion } of skills) {
    const st = skillState(ctx, skill, courseId);
    if (!st.eff || st.stale || st.eff.status === "dismissed" || !st.eff.primaryType) continue;
    const facts = routingFacts(ctx, skill, hasPracticeQuestion);
    const route = routeClassification(st.eff.primaryType, st.eff.secondary, facts);
    const input = objectiveInput(ctx, skill, courseId);
    const common = { sessionId, skillId: skill.id, skillVersion: skill.version, decisionId: st.eff.id, createdAt: now };
    const freeze = (templateId: NonNullable<Route["primary"]["templateId"]>, type: PacerType, optional: boolean) =>
      freezeActivity(templateId, type, optional, facts.material, {
        unitId: skill.unitId,
        objective: skill.objective,
        chunks: input.chunks,
        memoryRequirement: input.memoryRequirement,
      });
    const created: ActivityRow[] = [];
    if (!route.primary.templateId) {
      created.push(
        insertActivity(ctx.db, {
          ...common,
          templateId: "none",
          templateVersion: 0,
          role: "primary",
          frozen: {
            label: "No prepared activity for this approach",
            pacerType: route.primary.type,
            note: "The ordinary learning flow continues. Choose another approach on the topic page if you like.",
          },
          ordinal: ordinal++,
          status: "unavailable",
          stepIndex: 0,
        }),
      );
    } else {
      const frozen = freeze(route.primary.templateId, route.primary.type, false);
      created.push(insertActivity(ctx.db, { ...common, templateId: frozen.templateId, templateVersion: frozen.templateVersion, role: "primary", frozen, ordinal: ordinal++, status: "open", stepIndex: 0 }));
    }
    if (route.secondary) {
      const frozen = freeze(route.secondary.templateId, route.secondary.type, route.secondary.templateId !== "guided_practice");
      created.push(insertActivity(ctx.db, { ...common, templateId: frozen.templateId, templateVersion: frozen.templateVersion, role: "secondary", frozen, ordinal: ordinal++, status: "open", stepIndex: 0 }));
    }
    // Activity prompts and excerpts can teach: the exposure is committed before the session can return them.
    for (const a of created) {
      const f = a.frozen as FrozenActivity;
      if (a.status === "unavailable" || ((f.steps?.length ?? 0) === 0 && (f.excerpts?.length ?? 0) === 0)) continue;
      insertExposure(ctx.db, { sessionId, kind: "explanation", affectedSkillIds: [skill.id], contentRef: `pacer-activity:${a.id}`, recordedAt: now });
    }
  }
}

export function sessionActivitiesView(ctx: AppContext, sessionId: string) {
  return listActivities(ctx.db, sessionId).map((a) => {
    const responses = listResponses(ctx.db, a.id);
    const f = a.frozen as Partial<FrozenActivity> & { label: string; pacerType: PacerType; note: string };
    return {
      id: a.id,
      skillId: a.skillId,
      role: a.role,
      templateId: a.templateId,
      label: f.label,
      pacerType: f.pacerType,
      typeLabel: PACER_LABEL[f.pacerType],
      optional: !!f.optional,
      status: a.status,
      stepIndex: a.stepIndex,
      steps: f.steps ?? [],
      teachAfterStep: f.teachAfterStep ?? null,
      teachUnitId: f.teachUnitId ?? null,
      excerpts: f.excerpts ?? [],
      note: f.note,
      responses: responses.map((r) => ({ stepIndex: r.stepIndex, text: r.text, submittedAt: r.submittedAt, status: r.status })),
    };
  });
}

function requireActivity(ctx: AppContext, sessionId: string, activityId: string) {
  const a = getActivity(ctx.db, activityId);
  if (!a || a.sessionId !== sessionId) throw notFound("Learning activity");
  const session = ctx.db.prepare("SELECT status, mode FROM sessions WHERE id = ?").get(sessionId) as { status: string; mode: string } | undefined;
  if (!session) throw notFound("Session");
  return { a, session };
}

export interface ActivityResponseInput {
  submissionKey: string;
  stepIndex: number;
  text: string;
}

/**
 * Save a learning response once per submission key. A matching duplicate replays; changed content under the same key
 * is rejected. Completion is a workflow status only: no attempt, assessment, evidence or schedule change.
 */
export function submitActivityResponse(ctx: AppContext, sessionId: string, activityId: string, input: ActivityResponseInput) {
  const text = input.text.trim();
  if (!text) throw new AppError("validation", "Write a response, or skip this activity.");
  if (text.length > MAX_RESPONSE_CHARS) throw new AppError("validation", `Responses are limited to ${MAX_RESPONSE_CHARS} characters.`);
  return ctx.db.transaction(() => {
    const { a, session } = requireActivity(ctx, sessionId, activityId);
    const existing = getResponseByKey(ctx.db, sessionId, input.submissionKey);
    if (existing) {
      if (existing.activityId !== activityId || existing.stepIndex !== input.stepIndex || existing.text !== text) {
        throw new AppError("submission_key_conflict", "This submission key was already used with different content.");
      }
      return { duplicate: true, responseId: existing.id, status: getActivity(ctx.db, activityId)!.status };
    }
    if (session.status !== "active") throw new AppError("stale_phase", "This session has ended.");
    const f = a.frozen as FrozenActivity;
    if (a.status !== "open" || !f.steps || input.stepIndex !== a.stepIndex || a.stepIndex >= f.steps.length) {
      throw new AppError("stale_phase", "That is not the current step of this activity.");
    }
    const r = insertResponse(ctx.db, { activityId, sessionId, submissionKey: input.submissionKey, stepIndex: input.stepIndex, text, submittedAt: ctx.clock.now() });
    const next = a.stepIndex + 1;
    const status = next >= f.steps.length ? "completed" : f.teachAfterStep === a.stepIndex ? "teach" : "open";
    updateActivity(ctx.db, activityId, { status, stepIndex: next });
    return { duplicate: false, responseId: r.id, status };
  })();
}

/** Continue past teaching (explanation must already be revealed, i.e. its exposure committed) or skip an activity. */
export function advanceActivity(ctx: AppContext, sessionId: string, activityId: string, action: "continue" | "skip") {
  return ctx.db.transaction(() => {
    const { a, session } = requireActivity(ctx, sessionId, activityId);
    if (session.status !== "active") throw new AppError("stale_phase", "This session has ended.");
    if (action === "skip") {
      if (a.status === "completed" || a.status === "skipped") return { status: a.status };
      updateActivity(ctx.db, activityId, { status: "skipped", stepIndex: a.stepIndex });
      return { status: "skipped" as const };
    }
    if (a.status !== "teach") throw new AppError("stale_phase", "There is no teaching step to continue from.");
    const f = a.frozen as FrozenActivity;
    const taught = listExposures(ctx.db, sessionId).some((e) => e.kind === "explanation" && e.contentRef === `explanation:${f.teachUnitId}`);
    if (!taught) throw new AppError("stale_phase", "Read the explanation first.");
    updateActivity(ctx.db, activityId, { status: "open", stepIndex: a.stepIndex });
    return { status: "open" as const };
  })();
}

/** Learning responses for the topic history: shown as learning activities, never as checks or passes. */
export function topicActivityHistory(ctx: AppContext, topicId: string) {
  const rows = ctx.db
    .prepare(
      `SELECT r.id, r.response_text AS text, r.submitted_at AS submittedAt, r.step_index AS stepIndex, a.frozen_json AS frozen, a.skill_id AS skillId,
              a.session_id AS sessionId
       FROM pacer_responses r JOIN pacer_activities a ON a.id = r.activity_id JOIN sessions s ON s.id = a.session_id
       WHERE s.topic_id = ? ORDER BY r.submitted_at DESC, r.rowid DESC LIMIT 40`,
    )
    .all(topicId) as { id: string; text: string; submittedAt: number; stepIndex: number; frozen: string; skillId: string; sessionId: string }[];
  return rows.map((r) => {
    const f = JSON.parse(r.frozen) as FrozenActivity;
    const step = f.steps?.[r.stepIndex];
    return {
      kind: "activity" as const,
      at: r.submittedAt,
      id: r.id,
      sessionId: r.sessionId,
      skillId: r.skillId,
      label: `${TEMPLATE_LABEL[f.templateId] ?? f.label}${step ? ` · ${step.title}` : ""}`,
      typeLabel: PACER_LABEL[f.pacerType],
      text: r.text,
    };
  });
}

export { OFFLINE_PACER_MESSAGE };
