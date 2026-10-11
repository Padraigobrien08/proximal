import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { getStudyPlanSettings, setStudyPlanSettings } from "@/lib/services/settings";
import { listCourseSummaries } from "@/lib/services/views";

export const runtime = "nodejs";

function view() {
  const ctx = getAppContext();
  return {
    studyPlan: getStudyPlanSettings(ctx),
    modules: listCourseSummaries(ctx).map((c) => ({ id: c.id, title: c.title, status: c.status })),
  };
}

export const GET = route({ mutation: false }, () => ok(view()));

const bodySchema = z.strictObject({ studyPlan: z.unknown() });

export const PUT = route({ mutation: true }, async (req: Request) => {
  const body = await readJson(req, bodySchema);
  setStudyPlanSettings(getAppContext(), body.studyPlan);
  return ok(view());
});
