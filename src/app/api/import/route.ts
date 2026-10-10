import { AppError } from "@/lib/services/errors";
import { ok, route } from "@/lib/http/handler";
import { MAX_PDF_BYTES } from "@/lib/pdf/extract";
import { getAppContext } from "@/lib/server";
import { readEnvSafe } from "@/lib/env-safe";
import { importPdf } from "@/lib/services/imports";

export const runtime = "nodejs";

export const POST = route({ mutation: true }, async (req: Request) => {
  // Check declared size before parsing the multipart body.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_PDF_BYTES + 64 * 1024) throw new AppError("too_large", "PDF is larger than 10 MB.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError("validation", "Expected a multipart form upload with a 'file' field.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation", "Attach a PDF file in the 'file' field.");
  if (file.size > MAX_PDF_BYTES) throw new AppError("too_large", "PDF is larger than 10 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await importPdf(getAppContext(), readEnvSafe().dataDir, { name: file.name, bytes });
  return ok(result, result.reused ? 200 : 201);
});
