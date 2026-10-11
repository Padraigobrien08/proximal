import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { clampSessionMinutes, SESSION_MINUTES } from "@/lib/services/settings";
import { getHomeView } from "@/lib/services/views";

export const runtime = "nodejs";

export const GET = route({ mutation: false }, (req: Request) => {
  const budget = Number(new URL(req.url).searchParams.get("budget") ?? SESSION_MINUTES.default);
  return ok(getHomeView(getAppContext(), clampSessionMinutes(budget)));
});
