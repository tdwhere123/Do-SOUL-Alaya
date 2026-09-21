import { describe, expect, it } from "vitest";
import {
  decodeGeminiGenerateContent,
  GeminiProviderEnvelopeError,
  parseGeminiGenerateContentBody
} from "../../../runs/extraction/fill/batch/native-codec.js";

const usage = { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 3, totalTokenCount: 33 };

describe("native Gemini generateContent codec", () => {
  it("classifies a cancelled provider error envelope before generateContent decoding", () => {
    const envelope = { error: { code: 1, message: "The operation was cancelled." } };
    expect(() => decodeGeminiGenerateContent(envelope)).toThrow(GeminiProviderEnvelopeError);
    expect(() => decodeGeminiGenerateContent(envelope)).toThrow(/The operation was cancelled/u);
    expect(() => parseGeminiGenerateContentBody(JSON.stringify(envelope))).toThrow(GeminiProviderEnvelopeError);
    expect(() => decodeGeminiGenerateContent(undefined)).toThrow(/Gemini response is missing/u);
  });

  it("assembles delayed SSE and JSON-array stream parts while skipping thought-only parts", () => {
    const thought = { candidates: [{ content: { parts: [{ thought: true, text: "private" }] } }] };
    const raw = '{"signals":[]}';
    const prefix = { candidates: [{ content: { parts: [{ text: raw.slice(0, 5) }] } }] };
    const stop = {
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: raw.slice(5) }] } }],
      usageMetadata: usage
    };
    const sse = ["data: " + JSON.stringify(thought), "data: " + JSON.stringify(prefix),
      "data: " + JSON.stringify(stop), "data: [DONE]"].join("\n\n") + "\n\n";
    const decoded = decodeGeminiGenerateContent(parseGeminiGenerateContentBody(sse));
    expect(decoded.rawJson).toBe('{"signals":[]}');
    expect(decoded.usage).toEqual({ inputTokens: 10, outputTokens: 23, totalTokens: 33 });
    expect(decodeGeminiGenerateContent(parseGeminiGenerateContentBody(JSON.stringify([
      thought, { candidates: [{ content: { parts: [{ text: '{"signals":[]}' }] } }] },
      { candidates: [{ finishReason: "STOP", content: { parts: [] } }], usageMetadata: usage }
    ]))).rawJson).toBe('{"signals":[]}');
  });

  it("skips thought-signature parts that have no text", () => {
    expect(decodeGeminiGenerateContent({
      candidates: [{ finishReason: "STOP", content: { parts: [
        { thoughtSignature: "sig" },
        { text: '{"signals":[]}' }
      ] } }]
    }).rawJson).toBe('{"signals":[]}');
  });

  it("keeps nonempty JSON when the stream reports MAX_TOKENS and leaves missing finish unknown", () => {
    const raw = '{"signals":[]}';
    const truncated = decodeGeminiGenerateContent({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: raw }] } }],
      usageMetadata: usage
    });
    expect(truncated.rawJson).toBe(raw);
    expect(truncated.responseMetadata.finishReason).toBe("MAX_TOKENS");
    expect(truncated.responseMetadata.completionWitness).toBe("finish_reason");
    const missing = decodeGeminiGenerateContent({
      candidates: [{ content: { parts: [{ text: raw }] } }],
      usageMetadata: usage
    });
    expect(missing.rawJson).toBe(raw);
    expect(missing.responseMetadata.finishReason).toBeNull();
    expect(missing.responseMetadata.completionWitness).toBeUndefined();
  });

  it("preserves an explicit non-STOP finish reason without mapping it to MAX_TOKENS", () => {
    const decoded = decodeGeminiGenerateContent({
      candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: '{"signals":[]}' }] } }]
    });
    expect(decoded.responseMetadata.finishReason).toBe("SAFETY");
    expect(decoded.responseMetadata.completionWitness).toBe("finish_reason");
  });

  it("rejects thought-only STOP as empty model content", () => {
    expect(() => decodeGeminiGenerateContent({
      candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "private" }] } }]
    })).toThrow(/empty/u);
  });

  it("does not invent model JSON from a truncated SSE event", () => {
    expect(() => parseGeminiGenerateContentBody(
      "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"{\"}]}}\n\n"
    )).toThrow();
  });

  it("classifies an SSE provider error without assembling proposal text", () => {
    const sse = "data: " + JSON.stringify({ error: { code: 1, message: "The operation was cancelled." } }) + "\n\n";
    expect(() => parseGeminiGenerateContentBody(sse)).toThrow(GeminiProviderEnvelopeError);
  });
});
