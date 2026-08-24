import { vi } from "vitest";
import type { SignalExtractor } from "../../garden/pi-mono-extractor.js";

export function createContext() {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    turn_messages: [
      {
        role: "user" as const,
        content: "Call me Ash.",
        message_id: "message-1",
        created_at: "2026-04-23T09:00:00.000Z"
      }
    ]
  };
}

export function createExtractor(rawJson: string): SignalExtractor {
  return {
    extract: vi.fn(async () => ({ rawJson }))
  };
}

type OpenSemanticFactorGraphFixture = Readonly<Record<string, unknown>> & Readonly<{
  factors: readonly Readonly<Record<string, unknown>>[];
}>;

type OpenSemanticSignal<T> = T & Readonly<{
  semantic_factor_graph: OpenSemanticFactorGraphFixture;
}>;

export function withOpenSemanticFactorGraph<T extends Readonly<Record<string, unknown>>>(
  signal: T
): OpenSemanticSignal<T> {
  if (signal.semantic_factor_graph !== undefined) return signal as OpenSemanticSignal<T>;
  const matchedText = typeof signal.matched_text === "string" ? signal.matched_text : "";
  const surface = matchedText.slice(0, 64);
  return {
    ...signal,
    semantic_factor_graph: {
      schema_version: 2,
      source_kind: "evidence",
      factors: [{ factor_id: "f0", surface, semantic_identity: canonicalSemanticIdentity(surface) }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "p0",
        predicate_factor_id: "f0",
        arguments: [{
          position: 0,
          binding_identity: "assertion",
          reference_kind: "factor",
          reference_id: "f0"
        }]
      }]
    }
  };
}

export function openSignal<T extends Readonly<{ readonly matched_text: string }>>(
  signal: T,
  assertionId = 1
) {
  return {
    ...withOpenSemanticFactorGraph(signal),
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertionId
    }
  };
}

function canonicalSemanticIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function createOpenSemanticExtractor(rawJson: string): SignalExtractor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    return createExtractor(rawJson);
  }
  if (typeof parsed !== "object" || parsed === null ||
      !Array.isArray((parsed as { readonly signals?: unknown }).signals)) {
    return createExtractor(rawJson);
  }
  const record = parsed as { readonly signals: readonly unknown[] };
  return createExtractor(JSON.stringify({
    ...parsed,
    signals: record.signals.map((signal) =>
      typeof signal === "object" && signal !== null
        ? withOpenSemanticFactorGraph(signal as Readonly<Record<string, unknown>>)
        : signal)
  }));
}
