import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { classifyTopic } from "@/lib/services/pacer";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  skillIds: z.array(z.string().min(1)).max(20).optional(),
  regenerate: z.boolean().optional(),
});

/** Explicit, bounded classification request. Returns persisted drafts (never accepted) and safe summaries only. */
export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(await classifyTopic(getAppContext(), id, body));
});
