import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { getHomeView } from "@/lib/services/views";

export const runtime = "nodejs";

export const GET = route({ mutation: false }, (req: Request) => {
  const budget = Number(new URL(req.url).searchParams.get("budget") ?? 20);
  const minutes = [10, 20, 30].includes(budget) ? budget : 20;
  return ok(getHomeView(getAppContext(), minutes));
});
