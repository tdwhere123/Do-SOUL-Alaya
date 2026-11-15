import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { boundedArtifactEntryExists, readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable, replaceBytesDurable } from "../../extraction/fill/manifest/durable-exclusive-publication.js";
import { ExtractionTransportProvenanceSchema } from "../../extraction/transport-route.js";
import { bindSemanticProviderRequest, semanticProviderRequestCacheKey } from "../../provider-request/request-binding.js";
import { TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA, TEXT_MCP_ACTION_SCHEMA_NAME, encodeTextMcpRequest, textMcpUtf8Bytes } from "./codec.js";
import { TextMcpLiveSurfaceSchema, type TextMcpLiveSurface } from "./contract.js";
import {
  TEXT_MCP_PROVIDER_SESSION_CONTRACT, check, type TextMcpProviderSessionGrant
} from "./session-authority.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Admitted = z.object({
  turn: z.number().int().positive(),
  key: Digest,
  request_digest: Digest,
  kind: z.literal("task_consumer"),
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
  responseJsonSchema: z.unknown(),
  inputByteUpper: z.number().int().positive(),
  transportProvenance: ExtractionTransportProvenanceSchema,
  transcript_digest: Digest
}).strict();
export type TextMcpProviderSessionLine = z.infer<typeof Admitted> & {
  readonly responseJsonSchema: object;
};

const Transcript = z.object({
  contract: z.literal("text-mcp-provider-session-transcript-v1"),
  live_surface: TextMcpLiveSurfaceSchema,
  query: z.string().min(1),
  host_setup: z.boolean(),
  events: z.array(z.record(z.string(), z.unknown()))
}).strict();
export type TextMcpProviderSessionTranscript = z.infer<typeof Transcript>;

const transcriptPath = (root: string) => join(root, "session-transcript.json");
const admittedPath = (root: string, turn: number) => join(root, `admitted.${turn}.json`);

export function sessionTranscriptDigest(input: Readonly<{
  surface: TextMcpLiveSurface;
  query: string;
  events: readonly Record<string, unknown>[];
}>): string {
  return createHash("sha256").update(canonicalJson({
    surface: input.surface, query: input.query, events: input.events
  }), "utf8").digest("hex");
}

export function materializeTextMcpProviderSessionRequest(input: Readonly<{
  grant: TextMcpProviderSessionGrant;
  config: CompileSeedExtractionConfig;
  surface: TextMcpLiveSurface;
  query: string;
  events: readonly Record<string, unknown>[];
}>): Omit<TextMcpProviderSessionLine, "turn"> {
  const encoded = encodeTextMcpRequest({ surface: input.surface, query: input.query, events: input.events });
  if (textMcpUtf8Bytes(encoded) > input.grant.limits.max_input_bytes) {
    throw new AlayaError("CONFLICT", "session request exceeds granted input byte ceiling");
  }
  const responseJsonSchema = TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA;
  const request = Object.freeze({
    systemPrompt: encoded.systemPrompt, userPrompt: encoded.userPrompt,
    responseJsonSchema, maxOutputTokens: input.grant.limits.max_output_tokens
  });
  const bound = bindSemanticProviderRequest(input.config, request, TEXT_MCP_ACTION_SCHEMA_NAME);
  check(bound.inputByteUpper <= input.grant.limits.maximum_input_tokens_per_attempt,
    "session request exceeds granted input/window bounds");
  return Object.freeze({
    kind: "task_consumer" as const,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    responseJsonSchema,
    key: semanticProviderRequestCacheKey({
      identityPrefix: TEXT_MCP_PROVIDER_SESSION_CONTRACT, model: input.config.model,
      requestProfile: input.config.requestProfile, systemPrompt: request.systemPrompt, userPrompt: request.userPrompt,
      schema: request.responseJsonSchema, maxOutputTokens: request.maxOutputTokens,
      providerUrl: input.config.providerUrl, schemaName: TEXT_MCP_ACTION_SCHEMA_NAME
    }),
    request_digest: bound.requestDigest,
    inputByteUpper: bound.inputByteUpper,
    transportProvenance: bound.transportProvenance,
    transcript_digest: sessionTranscriptDigest({ surface: input.surface, query: input.query, events: input.events })
  });
}

export function admitTextMcpProviderSessionRequest(root: string, grant: TextMcpProviderSessionGrant,
  turn: number, derived: Omit<TextMcpProviderSessionLine, "turn">): TextMcpProviderSessionLine {
  check(turn >= 1 && turn <= grant.limits.max_model_turns, "session turn exceeds granted model-turn ceiling");
  check(!grant.history.closed_keys.includes(derived.key), "known closed session request");
  const existing = readAdmittedSessionRequest(root, turn);
  const line = Object.freeze({ ...derived, turn });
  if (existing !== undefined) {
    check(canonicalJson(existing) === canonicalJson(line), "session request drifted from its admitted transcript binding");
    return existing;
  }
  publishBytesExclusiveDurable({
    destination: admittedPath(root, turn),
    bytes: Buffer.from(JSON.stringify(line)),
    ownerIdentity: grant.lineage,
    temporaryDirectory: root
  });
  return line;
}

export function listAdmittedSessionRequests(root: string): TextMcpProviderSessionLine[] {
  const lines: TextMcpProviderSessionLine[] = [];
  for (let turn = 1; turn <= 16; turn += 1) {
    const line = readAdmittedSessionRequest(root, turn);
    if (line === undefined) break;
    check(line.turn === turn, "admitted session request ordinal drift");
    lines.push(line);
  }
  return lines;
}

export function readAdmittedSessionRequest(root: string, turn: number): TextMcpProviderSessionLine | undefined {
  const path = admittedPath(root, turn);
  if (!boundedArtifactEntryExists(path)) return undefined;
  const parsed = Admitted.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: 8 * 1024 * 1024, label: "admitted provider session request"
  })));
  check(canonicalJson(parsed.responseJsonSchema) === canonicalJson(TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA),
    "admitted session schema drifted");
  return Object.freeze({ ...parsed, responseJsonSchema: TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA });
}

export function readSessionTranscript(root: string): TextMcpProviderSessionTranscript | undefined {
  const path = transcriptPath(root);
  if (!boundedArtifactEntryExists(path)) return undefined;
  return Transcript.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: 8 * 1024 * 1024, label: "provider session transcript"
  })));
}

export function persistSessionTranscript(root: string, grant: TextMcpProviderSessionGrant,
  transcript: TextMcpProviderSessionTranscript): void {
  const parsed = Transcript.parse(structuredClone(transcript));
  const bytes = Buffer.from(JSON.stringify(parsed));
  const path = transcriptPath(root);
  if (!boundedArtifactEntryExists(path)) {
    publishBytesExclusiveDurable({
      destination: path, bytes, ownerIdentity: grant.lineage, temporaryDirectory: root
    });
    return;
  }
  const current = readSessionTranscript(root);
  if (current !== undefined && canonicalJson(current) === canonicalJson(parsed)) return;
  replaceBytesDurable({ destination: path, bytes, ownerIdentity: grant.lineage, temporaryDirectory: root });
}
