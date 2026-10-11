import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { askChat, getChatView } from "@/lib/services/chat";

export const runtime = "nodejs";

export const GET = route({ mutation: false, sensitiveRead: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(getChatView(getAppContext(), id));
});

const bodySchema = z.strictObject({
  question: z.string().min(1).max(2000),
  threadId: z.string().min(1).nullable().optional(),
});

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(await askChat(getAppContext(), id, body));
});
