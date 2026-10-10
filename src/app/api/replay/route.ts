import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { buildHistoricalReplay } from "@/lib/services/replay";

export const runtime = "nodejs";

export const GET = route({ mutation: false }, () => ok(buildHistoricalReplay(getAppContext())));
