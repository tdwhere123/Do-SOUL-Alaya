import { indexEntryCacheKey, type InformationIndex } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallRequest, NativeSourceNomination, ObserverReaders } from "@do-soul/alaya-core";
import type { SourceSemanticObserver } from "./source-semantic-observation.js";
import type { SourceSemanticLease } from "./source-semantic-leases.js";

type Pool = SourceSemanticLease["access_pool"];
type SourceRead = NonNullable<ObserverReaders["sourceRoot"]>;
type Fit = Parameters<NonNullable<ConditionalFieldRecallRequest["observe_page_fit"]>>[0];

/** Private observation of the shared producer. No selection, second reads,
 * response serialization or resource debits occur in this adapter. */
export class LibraryFieldObserver {
  private readonly sourceIds = new Map<string, string>();
  public constructor(private readonly observer: SourceSemanticObserver | undefined,
    private readonly grounded: Parameters<SourceSemanticObserver["facts"]["pool"]>[2]) {}

  public pool(nomination: NativeSourceNomination | null | undefined, bound: Pool, use: "created" | "reused"): void {
    if (this.observer === undefined) return;
    const native = bound?.sources ?? nomination?.result?.nominations.map(row => ({
      identity: row.source.target.root_id, source_id: row.source.source_id,
      source_version: row.source.target.source_version, content_digest: row.source.target.content_digest
    })) ?? [];
    const sources = [...new Map([...native, ...this.grounded].map(row => [row.identity, row])).values()];
    for (const source of sources) this.sourceIds.set(source.identity, source.source_id);
    const pool = bound ?? nomination;
    if (pool === null || pool === undefined) return;
    this.observer.facts.pool(pool, bound?.access.pool_id ?? nomination?.result?.navigation_digest ?? "unavailable",
      sources, bound?.access.unvisited_sources ?? nomination?.result?.completion !== "complete",
      bound?.access.unvisited_interpretations ?? true, use);
  }

  public nomination(nomination: NativeSourceNomination, bound: Pool, reused: boolean): void {
    this.pool(nomination, bound, reused ? "reused" : "created");
    if (reused) return;
    this.observer?.event("field_nomination", "observe", () => ({ result: nomination.result,
      witness: nomination.witness, beyond_observed_prefix: "unknown_not_nomination_limit" }));
  }

  public sourceRead(input: Parameters<SourceRead>[0], page: ReturnType<SourceRead>): void {
    const phase = input.purpose ?? "unclassified";
    this.observer?.event("source_read", phase, () => ({ purpose: phase,
      source_id: this.sourceIds.get(input.rootId), root_id: input.rootId,
      start: input.offset ?? 0, end: page.row?.content_end ?? null,
      bytes: page.bytesRead, metadata_bytes: page.metadataBytes ?? 0,
      native_work: page.nativeWork ?? page.rowsRead, read_calls: 1,
      complete: page.row?.content_complete ?? null,
      resource_limited: page.resourceLimited === true, unavailable: page.unavailable === true,
      chronology: "source_extent_summary" }));
    if (phase === "observation") this.observer?.event("observation_read_complete", phase, () => ({
      source_id: this.sourceIds.get(input.rootId), root_id: input.rootId,
      complete: page.row?.content_complete ?? null, resource_limited: page.resourceLimited === true,
      stop: page.unavailable ? "unavailable" : page.resourceLimited ? "budget"
        : page.row?.content_complete === false ? "bounded_extent" : "complete"
    }));
  }

  public fit(fit: Fit): void {
    if (fit.codec_invocations > 0) {
      this.observer?.facts.encodingInvocation("index", "field_page");
      this.observer?.event("encoding_attempt", "index", () => ({
        codec_invocations: fit.codec_invocations, entries: fit.index.entries.length }));
    }
    this.observer?.event("encoding_result", "index", () => ({ fits: fit.fits,
      bytes: fit.bytes, measurement: fit.interruption === undefined ? "complete" : "prefix",
      interruption: fit.interruption ?? null, result_count: fit.result_count }));
  }

  public plan(plan: NonNullable<SourceSemanticLease["field_page"]>, bound: Pool): void {
    const pool = bound ?? plan.nomination;
    if (pool !== null && pool !== undefined) this.observer?.facts.plan(plan, pool);
  }

  public delivered(index: InformationIndex, previews: ReadonlyMap<string, string>): void {
    this.observer?.event("encoded_membership", "index", () => ({ query_id: index.query_id,
      snapshot_id: index.snapshot_id, page_purpose: index.page_purpose,
      results: index.entries.map(entry => ({ target: entry.target,
        preview_bytes: Buffer.byteLength(previews.get(indexEntryCacheKey(entry)) ?? "", "utf8") })),
      continuation: index.continuation !== null }));
  }
}
