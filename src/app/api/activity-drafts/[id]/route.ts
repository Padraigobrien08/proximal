import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { approveMaterialDraft, rejectMaterialDraft } from "@/lib/services/materialDrafts";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ action: z.enum(["approve", "reject"]) });

/** Owner review of an activity draft. Approval makes the material (and any drafted explanation) available to new sessions. */
export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { action } = await readJson(req, bodySchema);
  const ctx = getAppContext();
  return ok(action === "approve" ? approveMaterialDraft(ctx, id) : rejectMaterialDraft(ctx, id));
});
