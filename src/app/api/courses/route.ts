import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { listCourseSummaries, providerInfo } from "@/lib/services/views";

export const runtime = "nodejs";

export const GET = route({ mutation: false }, () => {
  const ctx = getAppContext();
  return ok({ provider: providerInfo(ctx), courses: listCourseSummaries(ctx) });
});
