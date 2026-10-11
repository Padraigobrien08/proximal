import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { stopRun } from "@/lib/services/runs";

export const runtime = "nodejs";

export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(stopRun(getAppContext(), id));
});
