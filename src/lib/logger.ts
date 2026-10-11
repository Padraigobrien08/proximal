// Structured JSON-line logging to stdout. Callers pass metadata only: never answers, prompts, documents or keys.

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(event: string, fields: LogFields = {}, level: "info" | "warn" | "error" = "info"): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
