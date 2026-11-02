import { z } from "zod";
import { IsoDatetimeStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import { renderOfficialApiSourceCorpus } from "../garden/source-corpus.js";
import { HostIdentifierSchema, HostOccurrenceSchema, HostScopedReferenceSchema, type HostOccurrence, type HostScopedReference } from "./host-occurrence.js";

/** One host conversation captured message by message; every producer admits through this contract. */
export const HOST_SESSION_CONTRACT = "host-session-v1" as const;
export const HOST_SESSION_LIMITS = Object.freeze({ messagesPerRequest: 64, contentBytes: 16_384 });
const bytes = (text: string) => new TextEncoder().encode(text).length;

export const HostSessionRoleSchema = z.enum(["user", "assistant"]);
export const HostSessionMessageSchema = z.object({
  message_id: HostIdentifierSchema,
  position: NonNegativeIntSchema,
  role: HostSessionRoleSchema,
  content: z.string()
    .refine(value => bytes(value) <= HOST_SESSION_LIMITS.contentBytes, "host message exceeds its byte limit")
    .refine(value => !/[\uD800-\uDFFF]/u.test(value), "Unicode scalar text required"),
  completeness: z.enum(["complete", "excerpt"]),
  fidelity: z.enum(["original_bytes", "normalized", "unknown"]),
  host_reported_at: IsoDatetimeStringSchema.optional()
}).strict().readonly();
export type HostSessionMessage = z.infer<typeof HostSessionMessageSchema>;

export const HostSessionCaptureRequestSchema = z.object({
  container: HostScopedReferenceSchema,
  messages: z.array(HostSessionMessageSchema).min(1).max(HOST_SESSION_LIMITS.messagesPerRequest).readonly(),
  // The host asserts nothing follows yet: the pending round and the statement tail close now.
  closes_tail: z.boolean().optional()
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.messages.forEach((message, index) => {
    const previous = value.messages[index - 1];
    if (ids.has(message.message_id) || (previous !== undefined && message.position <= previous.position)) {
      context.addIssue({ code: "custom", message: "host messages must have unique ids and increasing positions" });
    }
    ids.add(message.message_id);
  });
}).readonly();
export type HostSessionCaptureRequest = z.infer<typeof HostSessionCaptureRequestSchema>;

export const HostSessionCaptureResponseSchema = z.object({
  container_key: z.string().min(1),
  admitted_message_count: NonNegativeIntSchema,
  replayed_message_count: NonNegativeIntSchema,
  pending_message_count: NonNegativeIntSchema,
  admitted_round_count: NonNegativeIntSchema
}).strict().readonly();
export type HostSessionCaptureResponse = z.infer<typeof HostSessionCaptureResponseSchema>;

/** Storage and session key of a container; scope and id together, never the id alone. */
export function hostSessionContainerKey(container: HostScopedReference, sha256: FieldContractSha256): string {
  return sha256(canonicalJson([container.scope, container.id])).slice(0, 32);
}

export function hostSessionStatementSessionId(containerKey: string): string {
  return `host-session:${containerKey}`;
}

export function hostSessionRoundSourceId(containerKey: string, roundIndex: number): string {
  return `host-session:${containerKey}:r${roundIndex}`;
}

/** Groups position-ordered messages into rounds: a user message pairs with the next message when that
 * one directly follows and is not a user message; every other message is its own round. A trailing user
 * message stays pending until a later message or tail closure decides its round.
 */
export function pairHostSessionRounds(messages: readonly Readonly<{ role: string; position: number }>[],
  closesTail: boolean): Readonly<{ rounds: readonly (readonly number[])[]; pendingFrom: number | null }> {
  const rounds: number[][] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!, next = messages[index + 1];
    if (message.role !== "user") { rounds.push([index]); index += 1; continue; }
    if (next === undefined && !closesTail) return { rounds, pendingFrom: index };
    if (next !== undefined && next.position === message.position + 1 && next.role !== "user") {
      rounds.push([index, index + 1]); index += 2; continue;
    }
    rounds.push([index]); index += 1;
  }
  return { rounds, pendingFrom: null };
}

export type HostSessionRoundSource = Readonly<{
  source_id: string; source_version: typeof HOST_SESSION_CONTRACT; content: string;
  occurrences: readonly HostOccurrence[]; event_time: string | null;
}>;

/** The retained root of one round: canonical rendering with one occurrence per host message. */
export function hostSessionRoundSource(container: HostScopedReference, containerKey: string, roundIndex: number,
  messages: readonly HostSessionMessage[]): HostSessionRoundSource {
  const rendered = renderOfficialApiSourceCorpus("", messages);
  const occurrences = rendered.occurrences.map(row => {
    const message = messages[row.message_index]!;
    return HostOccurrenceSchema.parse({ occurrence_id: message.message_id, utf8_span: row.utf8_span, role: message.role,
      channel: null, author_ref: null, container_ref: container, upstream_message_ref: null,
      upstream_position: message.position, completeness: message.completeness,
      // Rendering can only lose original bytes; a host-normalized message never regains them.
      fidelity: message.fidelity === "original_bytes" ? row.fidelity : message.fidelity,
      ...(message.host_reported_at === undefined ? {} : { host_reported_at: message.host_reported_at }) });
  });
  return Object.freeze({ source_id: hostSessionRoundSourceId(containerKey, roundIndex),
    source_version: HOST_SESSION_CONTRACT, content: rendered.content, occurrences: Object.freeze(occurrences),
    event_time: messages[0]?.host_reported_at ?? null });
}
