export type AppErrorCode =
  | "validation"
  | "not_found"
  | "stale_phase"
  | "conflict"
  | "submission_key_conflict"
  | "unavailable_reviewed_content"
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_malformed"
  | "provider_refusal"
  | "offline_unsupported"
  | "frozen"
  | "pdf_rejected"
  | "forbidden_origin"
  | "too_large";

const STATUS: Record<AppErrorCode, number> = {
  validation: 400,
  not_found: 404,
  stale_phase: 409,
  conflict: 409,
  submission_key_conflict: 409,
  unavailable_reviewed_content: 409,
  provider_timeout: 504,
  provider_unavailable: 503,
  provider_malformed: 502,
  provider_refusal: 422,
  offline_unsupported: 422,
  frozen: 409,
  pdf_rejected: 422,
  forbidden_origin: 403,
  too_large: 413,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} not found.`);
