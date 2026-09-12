import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ContinuationSchema, PagePurposeSchema, RecallTargetRefSchema, SoulMemorySearchResponseSchema, stableCanonicalStringify,
  type Continuation, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";

export const ExposureSlotSchema = z.object({
  relevance_score: z.number().finite(),
  rank: z.number().int().positive(), object_id: z.string().optional(), object_kind: z.string(),
  target: RecallTargetRefSchema, index_entry_offset: z.number().int().nonnegative(),
  hypothesis_id: z.string(), output_binding: z.string(),
  program_state: z.string().min(1), time_state: z.string().min(1)
}).strict().readonly();
const ExposureIdentity = z.object({ query_id: z.string(), snapshot_id: z.string(),
  interpretation_id: z.string(), as_of: z.string() }).strict().readonly();
const ScoringSlot = ExposureSlotSchema.unwrap().extend({ fused_score: z.number().nullable().optional(),
  abstention_confidence_score: z.number().nullable().optional() }).readonly();
const InitialExposure = z.object({
  session_id: z.string().min(1), delivery_id: z.string().min(1), identity: ExposureIdentity,
  slots: z.array(ExposureSlotSchema).max(10).readonly(),
  scoring_slots: z.array(ScoringSlot).max(10).readonly(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict().readonly();
export const FirstExposurePageSchema = z.object({
  delivery_id: z.string().min(1), request_continuation: ContinuationSchema.nullable(),
  page_purpose: PagePurposeSchema,
  initial: InitialExposure.nullable(),
  commitment: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict().readonly();
export type FirstExposurePage = z.infer<typeof FirstExposurePageSchema>;

function exposureDigest(initial: Omit<z.infer<typeof InitialExposure>, "digest">): string {
  return createHash("sha256").update(stableCanonicalStringify(initial)).digest("hex");
}

function pageCommitment(page: Omit<FirstExposurePage, "commitment">): string {
  return createHash("sha256").update(stableCanonicalStringify(page)).digest("hex");
}

export function exposureSlots(response: SoulMemorySearchResponse): z.infer<typeof ExposureSlotSchema>[] {
  return response.results.slice(0, 10).map((result, offset) => ({
    rank: offset + 1, index_entry_offset: offset, relevance_score: result.relevance_score,
    ...(result.object_id === undefined ? {} : { object_id: result.object_id }),
    object_kind: result.object_kind, target: result.target,
    hypothesis_id: result.hypothesis_id!, output_binding: result.output_binding!,
    program_state: result.program_state!, time_state: result.time_state!
  }));
}

export function firstExposureMismatch(page: FirstExposurePage, identity: z.infer<typeof ExposureIdentity>,
  currentSlots: readonly z.infer<typeof ExposureSlotSchema>[], deliveryId: string): boolean {
  const initial = page.initial;
  const { commitment, ...pageMaterial } = page;
  if (commitment !== pageCommitment(pageMaterial)) return true;
  if (initial === null || page.delivery_id !== deliveryId) return true;
  const { digest, ...material } = initial;
  if (digest !== exposureDigest(material)
    || stableCanonicalStringify(initial.identity) !== stableCanonicalStringify(identity)) return true;
  if (stableCanonicalStringify(initial.scoring_slots.map(({ fused_score: _fused, abstention_confidence_score: _confidence, ...slot }) => slot))
    !== stableCanonicalStringify(initial.slots)) return true;
  if (initial.slots.some((slot, offset) => slot.rank !== offset + 1 || slot.index_entry_offset !== offset)) return true;
  if (page.request_continuation === null) {
    return (page.page_purpose !== "membership" && page.page_purpose !== "retry") || initial.delivery_id !== deliveryId
      || stableCanonicalStringify(initial.slots) !== stableCanonicalStringify(currentSlots);
  }
  const continuation = page.request_continuation;
  return continuation.query_id !== identity.query_id || continuation.snapshot_id !== identity.snapshot_id
    || continuation.interpretation_id !== identity.interpretation_id || continuation.interpretation_clock !== identity.as_of;
}

/** Retained by the bench Recall handle; continuation cannot establish a new first exposure. */
export class FirstExposureSession {
  private readonly deliveries = new Map<string, z.infer<typeof InitialExposure>>();
  private readonly issued = new Map<string, z.infer<typeof InitialExposure>>();

  public record(response: SoulMemorySearchResponse, continuation?: Continuation | null,
    scoringSlots?: readonly z.infer<typeof ScoringSlot>[]): FirstExposurePage {
    const index = response.index;
    const purpose = index?.page_purpose ?? "membership";
    let initial = continuation == null ? this.deliveries.get(response.delivery_id) : this.issued.get(stableCanonicalStringify(continuation));
    if (initial === undefined && continuation == null && purpose === "membership" && index?.interpretation_id !== undefined && index.as_of !== undefined) {
      const material = { session_id: randomUUID(), delivery_id: response.delivery_id,
        identity: { query_id: index.query_id, snapshot_id: index.snapshot_id,
          interpretation_id: index.interpretation_id, as_of: index.as_of }, slots: exposureSlots(response),
        scoring_slots: scoringSlots ?? exposureSlots(response) };
      initial = InitialExposure.parse({ ...material, digest: exposureDigest(material) });
    }
    if (initial !== undefined) {
      this.deliveries.set(response.delivery_id, initial);
      while (this.deliveries.size > 256) this.deliveries.delete(this.deliveries.keys().next().value!);
    }
    if (initial !== undefined && index?.continuation != null) {
      this.issued.set(stableCanonicalStringify(index.continuation), initial);
      // Eviction makes old continuations unscorable instead of silently restarting a metric.
      while (this.issued.size > 256) this.issued.delete(this.issued.keys().next().value!);
    }
    const page = { delivery_id: response.delivery_id, request_continuation: continuation ?? null,
      page_purpose: purpose, initial: initial ?? null };
    return { ...page, commitment: pageCommitment(page) };
  }
}

export function initialScoringSlots(raw: unknown) {
  if (raw === null || typeof raw !== "object" || !("index" in raw)) return null;
  const row = raw as Record<string, unknown>;
  const parsed = SoulMemorySearchResponseSchema.safeParse({ delivery_id: row.delivery_id,
    protocol_version: row.protocol_version, results: row.results, index: row.index, total_count: row.total_count });
  if (!parsed.success || parsed.data.index === undefined) throw new Error("conditional Recall response is invalid");
  const response = parsed.data;
  const index = parsed.data.index;
  const page = FirstExposurePageSchema.safeParse(row.first_exposure_page);
  if (!page.success || page.data.page_purpose !== (index.page_purpose ?? "membership")
    || firstExposureMismatch(page.data, { query_id: index.query_id, snapshot_id: index.snapshot_id,
      interpretation_id: index.interpretation_id!, as_of: index.as_of! }, exposureSlots(response), response.delivery_id)) {
    throw new Error("conditional Recall first exposure unavailable or inconsistent");
  }
  return page.data.initial!.scoring_slots;
}
