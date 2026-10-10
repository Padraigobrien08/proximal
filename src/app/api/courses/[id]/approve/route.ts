import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { approveCourse } from "@/lib/services/imports";
import { getCourseView } from "@/lib/services/views";

export const runtime = "nodejs";

export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = getAppContext();
  const res = approveCourse(ctx, id);
  return ok({ ...res, course: getCourseView(ctx, id) });
});
