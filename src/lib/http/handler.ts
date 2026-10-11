import "server-only";
import { z } from "zod";
import { logEvent } from "../logger";
import { AppError } from "../services/errors";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostname(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0];
}

/**
 * Local-only request guard: accepted Host must be a loopback name (blocks DNS rebinding);
 * mutations require a same-origin Origin header; sensitive reads reject cross-site fetches.
 */
export function checkRequest(req: Request, opts: { mutation: boolean; sensitiveRead?: boolean }): void {
  const host = req.headers.get("host") ?? "";
  if (!LOCAL_HOSTS.has(hostname(host))) throw new AppError("forbidden_origin", "This local app only accepts loopback hosts.");
  const origin = req.headers.get("origin");
  const allowedOrigins = [`http://${host}`, `https://${host}`];
  if (opts.mutation) {
    if (!origin || !allowedOrigins.includes(origin)) {
      throw new AppError("forbidden_origin", "Cross-origin or origin-less mutation rejected.");
    }
  } else if (opts.sensitiveRead) {
    if (origin && !allowedOrigins.includes(origin)) throw new AppError("forbidden_origin", "Cross-origin read rejected.");
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") throw new AppError("forbidden_origin", "Cross-site read rejected.");
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(
      { error: { code: err.code, message: err.message, retryable: err.retryable } },
      { status: err.status, headers: { "cache-control": "no-store" } },
    );
  }
  if (err instanceof z.ZodError) {
    return Response.json(
      { error: { code: "validation", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), retryable: false } },
      { status: 400 },
    );
  }
  logEvent("unhandled_error", { name: (err as Error)?.name ?? "unknown", message: String((err as Error)?.message ?? err).slice(0, 300) }, "error");
  return Response.json({ error: { code: "internal", message: "Unexpected server error.", retryable: true } }, { status: 500 });
}

export function ok(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "cache-control": "no-store" } });
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("validation", "Request body must be JSON.");
  }
  return schema.parse(raw);
}

export function route<C>(
  opts: { mutation: boolean; sensitiveRead?: boolean },
  fn: (req: Request, ctx: C) => Promise<Response> | Response,
) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      checkRequest(req, opts);
      return await fn(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
