import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { MAX_CONNECTION_CHARS, setSkillConnection } from "@/lib/services/pacer";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ text: z.string().max(MAX_CONNECTION_CHARS) });

/** Save (or, with empty text, clear) the learner's own familiar connection for a skill. */
export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(setSkillConnection(getAppContext(), id, body.text));
});
