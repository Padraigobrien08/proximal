"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { "content-type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  let payload: { data?: T; error?: { code: string; message: string; retryable: boolean } } = {};
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(`Unexpected response (${res.status}).`, "internal", res.status, true);
  }
  if (!res.ok || payload.error) {
    const e = payload.error ?? { code: "internal", message: `Request failed (${res.status}).`, retryable: true };
    throw new ApiError(e.message, e.code, res.status, e.retryable);
  }
  return payload.data as T;
}
