import { z } from "zod";
import { SourceSemanticAcquisitionSchema, SourceSemanticResourceExhausted,
  type SourceIndexLexicalCandidate, type SourceIndexLexicalRead, type SourceIndexQueryRepository,
  type SourceRecordIdentity, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { CoreError, sourceGoldRootIdentity, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { sourceSemanticRevision } from "./source-semantic-leases.js";

const acquisitionShape = SourceSemanticAcquisitionSchema.unwrap().shape;
const lexicalSchema = acquisitionShape.lexical;
const rankSchema = acquisitionShape.nominations.unwrap().element.unwrap().shape.lexical.unwrap().element;
export const ResearchLexicalPrefixEvidenceSchema = z.object({
  pool_id: z.string(), snapshot_revision: z.string(), reader_limit: z.number().int().min(1).max(128),
  returned_rows: z.number().int().nonnegative().max(128), retained_rows: z.number().int().nonnegative().max(128),
  authorized_rows: z.number().int().nonnegative(), discarded_rows: z.number().int().nonnegative(),
  capture_status: z.enum(["complete", "partial"]), capture_reason: z.string().nullable(),
  reader: lexicalSchema, resources: acquisitionShape.resources,
  resource_refusal: acquisitionShape.resource_refusals.unwrap().element.nullable(),
  order: z.array(z.object({ root: z.string(), position: z.number().int().nonnegative(), lexical: rankSchema.nullable() }).strict()),
  statistics: z.literal("database-wide FTS statistics bound to the captured SQLite snapshot; not pool-conditioned"),
  exposure: z.literal("indexed full-body relevance, not bounded-preview relevance; null lexical means unranked")
}).strict().superRefine((value, context) => {
  if (value.returned_rows > value.reader_limit || value.retained_rows > value.returned_rows
    || value.authorized_rows + value.discarded_rows !== value.retained_rows
    || value.capture_status === "complete" && (value.retained_rows !== value.returned_rows || value.capture_reason !== null)
    || value.capture_status === "partial" && value.capture_reason === null) {
    context.addIssue({ code: "custom", message: "lexical prefix counts and partial capture must remain explicit" });
  }
});
export type ResearchLexicalPrefixEvidence = z.output<typeof ResearchLexicalPrefixEvidenceSchema>;
type Header = Omit<SourceIndexLexicalRead, "candidates">;

/** Request-only original-reader evidence. Named consumer: private acquisition comparison.
 * Remove after its bounded decision unless explicitly retained for reproduction. No admission authority.
 */
export class ResearchLexicalPrefixCapture {
  readonly rows: SourceIndexLexicalCandidate[] = [];
  header: Header | undefined;
  revision: string | undefined;
  limit = 0;
  returned = 0;
  reason: string | null;
  private readonly meter?: SourceSemanticReadBudget;
  private readonly baselineWork: number;
  private readonly baselineBytes: number;

  /** The caller supplies the existing request-budget fork, never the native ledger. */
  constructor(payload: SourceSemanticWorkerPayload, parent: SourceSemanticReadBudget) {
    const request = payload.request;
    this.reason = request.kind !== "recall" || request.query_handle !== undefined || request.continuation !== undefined
      ? "initial_direct_recall_required"
      : request.query_semantics !== undefined || request.query_semantics_unavailable !== undefined
        ? "supplied_query_semantics_not_absence"
        : (request.semantic_correspondences?.length ?? 0) > 0 ? "proof_free_raw_packages_required"
          : payload.acquisition_control === "vector" ? "lexical_channel_not_requested" : "lexical_reader_not_run";
    if (this.reason === "lexical_reader_not_run") this.meter = parent;
    this.baselineWork = parent.spentWork; this.baselineBytes = parent.spentBytes;
  }

  /** Decorate only the original route. All native results/arguments and other methods pass through. */
  repository(repository: SourceIndexQueryRepository, runtime: SourceSemanticReadRuntime): SourceIndexQueryRepository {
    if (this.meter === undefined) return repository;
    return {
      readLexicalCandidates: (...args) => {
        const result = repository.readLexicalCandidates(...args);
        this.capture(result, args[2], args[3], runtime);
        return result;
      },
      readVectorCandidates: (...args) => repository.readVectorCandidates(...args),
      admitQueryCandidate: (...args) => repository.admitQueryCandidate(...args)
    };
  }

  private capture(read: SourceIndexLexicalRead, limit: number, budget: SourceSemanticResourceBudget,
    runtime: SourceSemanticReadRuntime): void {
    const meter = this.meter!;
    // Optional retention uses only the existing acquisition allowance, never native finalization's reserve.
    meter.work = Math.min(meter.work, budget.work_units); meter.bytes = Math.min(meter.bytes, budget.memory_bytes);
    this.limit = limit; this.returned = read.candidates.length;
    try {
      meter.charge(2, 128, "research lexical snapshot revision");
      const revision = sourceSemanticRevision(runtime);
      meter.retain(revision, "research lexical snapshot binding"); this.revision = revision;
      meter.charge(1, 256, "research lexical metadata frame");
      const { candidates: _candidates, ...header } = read;
      meter.retain(header, "research lexical reader metadata"); this.header = structuredClone(header);
      for (const row of read.candidates) {
        meter.retain(row, "research lexical retained preadmission row");
        meter.charge(1, 16, "research lexical retained row reference"); this.rows.push(structuredClone(row));
      }
      this.reason = null;
    } catch (error) {
      // Nothing from optional capture may fail native acquisition, including unexpected capture errors.
      this.reason = error instanceof SourceSemanticResourceExhausted ? "lexical_capture_resource_exhausted" : "lexical_capture_failed";
    }
  }

  /** Each counterfactual carries incurred capture work on top of its actual common acquisition. */
  cost(): SourceSemanticResourceBudget {
    return { work_units: this.meter === undefined ? 0 : this.meter.spentWork - this.baselineWork,
      memory_bytes: this.meter === undefined ? 0 : this.meter.spentBytes - this.baselineBytes };
  }

  carryInto(meter: SourceSemanticReadBudget): void {
    const cost = this.cost();
    meter.charge(cost.work_units, cost.memory_bytes, "research incurred lexical capture");
  }

  evidence(runtime: SourceSemanticReadRuntime, poolId: string, records: readonly SourceRecordIdentity[],
    candidates: readonly SourceSemanticLibraryPackage[], meter: SourceSemanticReadBudget): ResearchLexicalPrefixEvidence {
    if (this.header === undefined || this.revision === undefined) throw new CoreError("CONFLICT", "lexical capture is unavailable");
    meter.charge(2, 0, "research lexical snapshot recheck");
    if (sourceSemanticRevision(runtime) !== this.revision) throw new CoreError("CONFLICT", "lexical capture snapshot changed");
    return projectResearchLexicalPrefix(this, poolId, records, candidates, meter);
  }
}

/** Intersect only with records already re-admitted by bindVerifiedResearchSourceRecords and raw prefix packages.
 * Unchecked identifiers stay request-local; first reader occurrence, not score fusion, owns root order.
 */
export function projectResearchLexicalPrefix(capture: ResearchLexicalPrefixCapture, poolId: string,
  records: readonly SourceRecordIdentity[], candidates: readonly SourceSemanticLibraryPackage[],
  meter: SourceSemanticReadBudget): ResearchLexicalPrefixEvidence {
  meter.charge(records.length + candidates.length, 64 + records.length * 32 + candidates.length * 16,
    "research lexical authorized package census");
  const byRoot = new Map(records.map(row => [row.identity, row]));
  const packageRoots = new Map(candidates.map(row => [row, packageRoot(row, meter)]));
  const eligible = new Set(packageRoots.values());
  const seen = new Set<string>(), order: ResearchLexicalPrefixEvidence["order"] = [];
  let authorizedRows = 0;
  for (const row of capture.rows) {
    meter.charge(1, 0, "research lexical exact tuple intersection");
    const target = row.source.target, record = byRoot.get(target.root_id);
    if (record === undefined || row.source.source_id !== record.source_id || target.workspace_id !== record.workspace_id
      || target.source_version !== record.source_version || target.content_digest !== record.content_digest
      || row.source.root_key !== meteredRoot(target, meter) || !eligible.has(row.source.root_key)) continue;
    authorizedRows++;
    if (seen.has(row.source.root_key)) continue;
    meter.retain(row.lexical, "research lexical rank projection");
    meter.charge(1, 128 + row.source.root_key.length * 4, "research lexical authorized proposal");
    seen.add(row.source.root_key); order.push({ root: row.source.root_key, position: order.length, lexical: row.lexical });
  }
  meter.charge(candidates.length * Math.max(1, Math.ceil(Math.log2(candidates.length))), candidates.length * 8,
    "research lexical unranked access order");
  for (const row of [...candidates].sort((a, b) => a.access_position - b.access_position)) {
    const root = packageRoots.get(row)!;
    if (seen.has(root)) continue;
    meter.charge(1, 128 + root.length * 4, "research lexical unranked proposal");
    seen.add(root); order.push({ root, position: order.length, lexical: null });
  }
  const header = capture.header!;
  const result: ResearchLexicalPrefixEvidence = { pool_id: poolId, snapshot_revision: capture.revision!, reader_limit: capture.limit,
    returned_rows: capture.returned, retained_rows: capture.rows.length, authorized_rows: authorizedRows,
    discarded_rows: capture.rows.length - authorizedRows, capture_status: capture.reason === null ? "complete" : "partial",
    capture_reason: capture.reason, reader: { completion: header.completion, reason: header.reason,
      index_coverage: header.index_coverage, tokenization: header.tokenization, limitations: header.limitations },
    resources: header.resources, resource_refusal: header.resource_refusal, order,
    statistics: "database-wide FTS statistics bound to the captured SQLite snapshot; not pool-conditioned",
    exposure: "indexed full-body relevance, not bounded-preview relevance; null lexical means unranked" };
  meter.retain(result, "research lexical evidence and transport references");
  return result;
}

function packageRoot(row: SourceSemanticLibraryPackage, meter: SourceSemanticReadBudget): string {
  if (row.entry.target.kind !== "source_evidence" || row.proofs.length !== 0) {
    throw new CoreError("CONFLICT", "lexical contrast requires proof-free raw prefix packages");
  }
  return meteredRoot(row.entry.target, meter);
}

function meteredRoot(target: Parameters<typeof sourceGoldRootIdentity>[0], meter: SourceSemanticReadBudget): string {
  // The complete target overquotes the owner's smaller root projection; never redefine its identity material.
  const size = meter.canonicalJsonLength(target);
  meter.charge(size, size * 4, "research lexical root identity projection");
  return sourceGoldRootIdentity(target);
}
