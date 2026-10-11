import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { startNewThread } from "@/lib/services/chat";

export const runtime = "nodejs";

export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok({ threadId: startNewThread(getAppContext(), id) });
});
