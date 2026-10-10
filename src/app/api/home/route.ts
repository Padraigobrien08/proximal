import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { getHomeView } from "@/lib/services/views";

export const runtime = "nodejs";

export const GET = route({ mutation: false }, (req: Request) => {
  const budget = Number(new URL(req.url).searchParams.get("budget") ?? 20);
  const minutes = (budget === 10 || budget === 30 ? budget : 20) as 10 | 20 | 30;
  return ok(getHomeView(getAppContext(), minutes));
});
