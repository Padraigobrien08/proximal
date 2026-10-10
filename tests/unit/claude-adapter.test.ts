import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeProvider } from "../../src/lib/llm/claude";
import { ProviderError, type AssessmentInput } from "../../src/lib/llm/types";
import { checkRequest } from "../../src/lib/http/handler";
import { readEnv } from "../../src/lib/env";

const input: AssessmentInput = {
  questionId: "S4-A",
  taskType: "explain",
  prompt: "What does BCE penalise?",
  rubric: {
    version: 1,
    criteria: [{ id: "c1", essential: true, description: "d", acceptableEquivalents: [], fatalIfNotMet: false }],
  },
  reference: { summary: "ref", numericChecks: [] },
  sourceText: "[page 4] text",
  answer: "Low probability on the true label.",
};

function message(text: string, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  } as unknown as Anthropic.Message;
}

function fakeClient(responses: (Anthropic.Message | Error)[], calls: unknown[] = []) {
  return {
    messages: {
      create: async (params: unknown) => {
        calls.push(params);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
}

const valid = JSON.stringify({
  criteria: [{ criterionId: "c1", status: "met", answerQuote: "Low probability", briefReason: "ok" }],
  possibleMisconception: null,
});

describe("Claude adapter", () => {
  it("requests structured output with the configured model and records usage", async () => {
    const calls: Record<string, unknown>[] = [];
    const p = new ClaudeProvider({ apiKey: "k", model: "configured-model", client: fakeClient([message(valid)], calls) });
    const res = await p.assessAnswer(input);
    expect(res.output.criteria[0].status).toBe("met");
    expect(res.meta).toMatchObject({ mode: "live", model: "configured-model", promptVersion: "assessor-v1", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(calls[0].model).toBe("configured-model");
    expect(calls[0]).toHaveProperty("output_config.format.type", "json_schema");
    // Learner text lives in the user turn, never in system instructions.
    expect(String(calls[0].system)).not.toContain(input.answer);
    expect(JSON.stringify(calls[0].messages)).not.toMatch(/confidence|evidence_state|mastery/i);
  });

  it("permits exactly one malformed-output repair, then fails as a provider error", async () => {
    const calls: unknown[] = [];
    const ok = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient([message("not json"), message(valid)], calls) });
    await expect(ok.assessAnswer(input)).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);

    const bad = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient([message("{}"), message('{"criteria": 5}')]) });
    await expect(bad.assessAnswer(input)).rejects.toMatchObject({ code: "provider_malformed" });
  });

  it("rejects tool calls and refusals", async () => {
    const tool = message("", { content: [{ type: "tool_use", id: "t", name: "write_db", input: {} }] as unknown as Anthropic.Message["content"] });
    const p = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient([tool, tool]) });
    await expect(p.assessAnswer(input)).rejects.toBeInstanceOf(ProviderError);
    const refusal = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient([message("", { stop_reason: "refusal" })]) });
    await expect(refusal.assessAnswer(input)).rejects.toMatchObject({ code: "provider_refusal" });
  });

  it("T22: timeouts map to a retryable provider_timeout error (never a mock result)", async () => {
    const p = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient([new Anthropic.APIConnectionTimeoutError()]) });
    await expect(p.assessAnswer(input)).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
  });
});

describe("environment", () => {
  it("live mode requires both Anthropic variables and never picks a model", () => {
    expect(() => readEnv({ LLM_MODE: "live", ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_MODEL/);
    expect(readEnv({} as NodeJS.ProcessEnv).LLM_MODE).toBe("mock");
  });
});

describe("local request guard", () => {
  const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/x", { method: "POST", headers });
  it("requires loopback host and same-origin for mutations", () => {
    expect(() => checkRequest(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), { mutation: true })).not.toThrow();
    expect(() => checkRequest(req({ host: "127.0.0.1:3000", origin: "http://evil.test" }), { mutation: true })).toThrow();
    expect(() => checkRequest(req({ host: "127.0.0.1:3000" }), { mutation: true })).toThrow();
    expect(() => checkRequest(req({ host: "evil.test", origin: "http://evil.test" }), { mutation: true })).toThrow();
    expect(() =>
      checkRequest(req({ host: "localhost:3000", "sec-fetch-site": "cross-site" }), { mutation: false, sensitiveRead: true }),
    ).toThrow();
  });
});
