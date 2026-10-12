// Authored activity registry and routing (pacer-activities-v1). Not an AI planner: a reviewed type selects a template,
// and a template is available only when the approved material it needs exists. Pure and client-safe.
import { PACER_ROUTING_VERSION, type MemoryRequirement, type PacerType } from "./taxonomy";

export type TemplateId =
  | "guided_practice"
  | "connect_reconstruct"
  | "create_analogy"
  | "map_critique"
  | "claim_support_limits"
  | "capture_locate";

export const TEMPLATE_VERSION = 1;

export const TEMPLATE_LABEL: Record<TemplateId, string> = {
  guided_practice: "Practise and apply",
  connect_reconstruct: "Connect and explain",
  create_analogy: "Make your own comparison",
  map_critique: "Map and critique a comparison",
  claim_support_limits: "Claim, support and limits",
  capture_locate: "Capture and locate",
};

/** Default activity per primary type. */
export const DEFAULT_TEMPLATE: Record<PacerType, TemplateId> = {
  procedural: "guided_practice",
  analogous: "map_critique",
  conceptual: "connect_reconstruct",
  supporting_evidence: "claim_support_limits",
  reference: "capture_locate",
};

/** Authored per-skill learning material (approved content; never generated). */
export interface ActivityMaterial {
  connect?: { concepts: string[]; prompt: string; hints: string[] };
  reconstruct?: { prompt: string };
  analogy?: { chunkId: string; prompt: string };
  evidence?: { chunkId: string; excerpt: string; claim: string; prompt: string };
  reference?: { chunkId: string; excerpt: string; page: number | null; prompt: string; recallPrompt: string | null };
  createAnalogy?: { prompt: string };
}

export interface RoutingFacts {
  material: ActivityMaterial;
  /** Approved checked explanation exists for the unit (teaching between Connect and Reconstruct). */
  hasCheckedExplanation: boolean;
  /** A reviewed practice question for this skill is frozen in the session. */
  hasPracticeQuestion: boolean;
  /** An approved chunk with an explicit comparison exists. */
  hasApprovedAnalogyChunk: boolean;
  memoryRequirement: MemoryRequirement;
}

export function templateAvailable(t: TemplateId, f: RoutingFacts): boolean {
  switch (t) {
    case "guided_practice":
      return f.hasPracticeQuestion;
    case "connect_reconstruct":
      return f.hasCheckedExplanation && !!f.material.connect && !!f.material.reconstruct;
    case "create_analogy":
      return !!f.material.createAnalogy;
    case "map_critique":
      return f.hasApprovedAnalogyChunk && !!f.material.analogy;
    case "claim_support_limits":
      return !!f.material.evidence;
    case "capture_locate":
      return !!f.material.reference;
  }
}

/** Secondary-type activity (at most one is offered); creating an analogy is offered for conceptual material. */
const SECONDARY_TEMPLATE: Record<PacerType, TemplateId[]> = {
  procedural: ["guided_practice"],
  analogous: ["map_critique"],
  conceptual: ["connect_reconstruct", "create_analogy"],
  supporting_evidence: ["claim_support_limits"],
  reference: ["capture_locate"],
};

export interface Route {
  routingVersion: string;
  primary: { type: PacerType; templateId: TemplateId | null; label: string };
  /** At most one optional additional activity from a secondary type. */
  secondary: { type: PacerType; templateId: TemplateId; label: string } | null;
}

/** Route a reviewed classification. A missing template is reported honestly (templateId null), never substituted. */
export function routeClassification(primary: PacerType, secondary: PacerType[], f: RoutingFacts): Route {
  const t = DEFAULT_TEMPLATE[primary];
  const primaryTemplate = templateAvailable(t, f) ? t : null;
  let extra: Route["secondary"] = null;
  for (const s of secondary) {
    const pick = SECONDARY_TEMPLATE[s].find((x) => x !== primaryTemplate && templateAvailable(x, f));
    if (pick) {
      extra = { type: s, templateId: pick, label: TEMPLATE_LABEL[pick] };
      break;
    }
  }
  // A conceptual objective may offer creating an analogy without claiming the source contains one.
  if (!extra && primary === "conceptual" && primaryTemplate && templateAvailable("create_analogy", f)) {
    extra = { type: "conceptual", templateId: "create_analogy", label: TEMPLATE_LABEL.create_analogy };
  }
  return {
    routingVersion: PACER_ROUTING_VERSION,
    primary: { type: primary, templateId: primaryTemplate, label: primaryTemplate ? TEMPLATE_LABEL[primaryTemplate] : "No prepared activity" },
    secondary: extra,
  };
}

// ---------------------------------------------------------------- frozen activity content

export interface FrozenStep {
  key: "connect" | "reconstruct" | "respond" | "recall";
  title: string;
  prompt: string;
  hints: string[];
  /** Shown above the response box. */
  expected: string;
}

export interface FrozenActivity {
  templateId: TemplateId;
  templateVersion: number;
  routingVersion: string;
  pacerType: PacerType;
  label: string;
  optional: boolean;
  steps: FrozenStep[];
  /** connect_reconstruct: teaching is revealed between the steps (explanation exposure recorded first). */
  teachAfterStep: number | null;
  teachUnitId: string | null;
  /** Approved excerpts shown with the activity (source-linked). */
  excerpts: { chunkId: string; label: string; page: number | null; text: string; origin: "source" | "authored_context" | "learner" }[];
  note: string;
}

const LEARNING_NOTE = "This is a learning activity. Your response is saved, but it is not a check and does not change your level.";

export function freezeActivity(
  templateId: TemplateId,
  pacerType: PacerType,
  optional: boolean,
  m: ActivityMaterial,
  ctx: { unitId: string; objective: string; chunks: { chunkId: string; label: string; page: number | null; text: string; kind: string }[]; memoryRequirement: MemoryRequirement },
): FrozenActivity {
  const base = {
    templateId,
    templateVersion: TEMPLATE_VERSION,
    routingVersion: PACER_ROUTING_VERSION,
    pacerType,
    label: TEMPLATE_LABEL[templateId],
    optional,
    teachAfterStep: null as number | null,
    teachUnitId: null as string | null,
    excerpts: [] as FrozenActivity["excerpts"],
    note: LEARNING_NOTE,
  };
  const chunk = (id: string) => ctx.chunks.find((c) => c.chunkId === id);
  switch (templateId) {
    case "guided_practice":
      return {
        ...base,
        steps: [],
        note: "Show your steps, the result and why each step applies. Help is available, so a correct answer counts as practice, not a check.",
      };
    case "connect_reconstruct":
      return {
        ...base,
        teachAfterStep: 0,
        teachUnitId: ctx.unitId,
        steps: [
          {
            key: "connect",
            title: "Connect",
            prompt: m.connect!.prompt,
            hints: m.connect!.hints,
            expected: `How these relate, and why: ${m.connect!.concepts.join(" · ")}. You can sketch on paper and describe your links here.`,
          },
          {
            key: "reconstruct",
            title: "Reconstruct from memory",
            prompt: m.reconstruct!.prompt,
            hints: [],
            expected: "The key reasoning in your own words, with the explanation hidden. This is not the later no-help check.",
          },
        ],
      };
    case "create_analogy":
      return {
        ...base,
        steps: [
          {
            key: "respond",
            title: "Your comparison",
            prompt: m.createAnalogy!.prompt,
            hints: [],
            expected: "Your own comparison, one way it fits and one place it breaks down. This is your analogy, not the lecture's.",
          },
        ],
      };
    case "map_critique": {
      const c = chunk(m.analogy!.chunkId);
      return {
        ...base,
        excerpts: c ? [{ chunkId: c.chunkId, label: c.label, page: c.page, text: c.text, origin: "authored_context" }] : [],
        steps: [
          {
            key: "respond",
            title: "Map and critique",
            prompt: m.analogy!.prompt,
            hints: [],
            expected: "Which parts correspond, one useful similarity and one limitation.",
          },
        ],
      };
    }
    case "claim_support_limits": {
      const c = chunk(m.evidence!.chunkId);
      return {
        ...base,
        excerpts: [
          {
            chunkId: m.evidence!.chunkId,
            label: c?.label ?? "Approved material",
            page: c?.page ?? null,
            text: m.evidence!.excerpt,
            origin: c?.kind === "page" ? "source" : "authored_context",
          },
        ],
        steps: [
          {
            key: "respond",
            title: "Claim, support and limits",
            prompt: `${m.evidence!.prompt}\n\nClaim: ${m.evidence!.claim}`,
            hints: [],
            expected: "What the example supports, how it supports it, its assumptions and what it does not show.",
          },
        ],
      };
    }
    case "capture_locate": {
      const c = chunk(m.reference!.chunkId);
      const steps: FrozenStep[] = [
        {
          key: "respond",
          title: "Capture and locate",
          prompt: m.reference!.prompt,
          hints: [],
          expected: "A short reference note in your own words and where it is in the source.",
        },
      ];
      // Recall is practised only for an explicit recall objective. Lookup permission affects this activity only.
      if (ctx.memoryRequirement === "recall_required" && m.reference!.recallPrompt) {
        steps.push({ key: "recall", title: "Recall", prompt: m.reference!.recallPrompt, hints: [], expected: "Write it from memory." });
      }
      return {
        ...base,
        excerpts: [
          {
            chunkId: m.reference!.chunkId,
            label: c?.label ?? "Approved material",
            page: m.reference!.page,
            text: m.reference!.excerpt,
            origin: c?.kind === "page" ? "source" : "authored_context",
          },
        ],
        steps,
      };
    }
  }
}
