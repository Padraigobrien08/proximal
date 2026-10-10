import { route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { readEnvSafe } from "@/lib/env-safe";
import { openSourceFile } from "@/lib/services/imports";

export const runtime = "nodejs";

export const GET = route({ mutation: false, sensitiveRead: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const file = openSourceFile(getAppContext(), readEnvSafe().dataDir, id);
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${file.name.replace(/[^\w.\- ]/g, "_")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-proximal-exposed-sessions": String(file.exposedSessions),
    },
  });
});
