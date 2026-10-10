import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { retryAttemptAssessment } from "@/lib/services/sessions";

export const runtime = "nodejs";

export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const res = await retryAttemptAssessment(getAppContext(), id);
  // Checkpoint judgements stay hidden until release: only report status here.
  return ok({ status: res.status, ...(res.status === "provider_error" ? { code: res.code, message: res.message, retryable: res.retryable } : {}) });
});
