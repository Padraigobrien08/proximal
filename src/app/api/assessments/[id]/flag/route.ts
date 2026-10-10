import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { flagAssessment } from "@/lib/services/assessments";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ reason: z.string().trim().min(3).max(500) });

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  const res = flagAssessment(getAppContext(), id, body.reason);
  return ok({ assessmentId: res.assessment.id, excluded: res.assessment.excluded, skillId: res.skillId, evidenceState: res.state.evidenceState });
});
