import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { startRun } from "@/lib/services/runs";
import { SESSION_MINUTES } from "@/lib/services/settings";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  budgetMinutes: z
    .number()
    .int()
    .min(SESSION_MINUTES.min)
    .max(SESSION_MINUTES.max)
    .refine((m) => m % SESSION_MINUTES.step === 0, { message: `Session length must be a multiple of ${SESSION_MINUTES.step} minutes.` })
    .default(SESSION_MINUTES.default),
  courseId: z.string().min(1).optional(),
  topicId: z.string().min(1).optional(),
});

export const POST = route({ mutation: true }, async (req: Request) => {
  const body = await readJson(req, bodySchema);
  return ok(startRun(getAppContext(), body), 201);
});
