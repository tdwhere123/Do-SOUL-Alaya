import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, type SourceSemanticHandleDescriptor,
  type SourceEvidenceTarget, type SourceSemanticCorrespondence } from "@do-soul/alaya-protocol";
import { projectSourceDisclosure, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
  SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION } from "@do-soul/alaya-core";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { ACCESS_BUDGET, CLOCK, WS, withAccessLibrary }
  from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { JOINT_QUESTION, jointQuery, jointSource, jointCorrespondence, jointSelection }
  from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-joint.test-support.js";
import { correspondenceAssessmentJson } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { admitRetainedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { captureSourceAcquisitionLaunchBinding, type SourceAcquisitionExperimentInput }
  from "../../../runs/semantic-chain/source-acquisition-experiment.js";
import { interpretedQueryRaw } from "../../longmemeval/query-producer-fixture.js";
import { authoredProposal } from "./source-qualified-selection.test-support.js";

const PRODUCER = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
  provider_url: "https://generativelanguage.googleapis.com" };
const TOKENS = 16384;
const GUARD = `--import=${new URL("../../support/strict-provider-free-cli-bootstrap.mjs", import.meta.url).href}`;

/** Current publications and received authored Q/C, never signed or caller-invented local proofs. */
export async function withQualifiedJointFixture(directory: string,
  body: (fixture: { input: SourceAcquisitionExperimentInput; sources: { id: string; text: string }[] }) => Promise<void>) {
  // Four wrong-ticket approvals precede the required Approval in the native identity tie-break.
  // This plants a first-page omission without adding proofs beyond the unchanged allowance.
  const sources = [jointSource("a", true), ...[1, 2, 4, 5].map(n => jointSource(`b${n}`, false, { value: `OTHER-${n}` })),
    ...Array.from({ length: 10 }, (_, n) => ({ id: `c${n}`, text: `Independent retained raw memo ${n}.`, verbatim: true })), jointSource("z", false)];
  const descriptors = new Map<string, SourceSemanticHandleDescriptor>(), targets = new Map<string, SourceEvidenceTarget>();
  process.execArgv.push(GUARD);
  try {
    await withAccessLibrary(sources, async ({ filename }) => {
      const retained = join(directory, "retained.sqlite"), snapshot = join(directory, "native.sqlite"), root = join(directory, "experiment");
      checkpointAndCopyBenchDb(filename, retained);
      const manifest = await admitRetainedNativeSourceSnapshot({ retainedPath: retained, expectedSha256: hashRegularFileNoFollow(retained),
        snapshotPath: snapshot, workspaceId: WS, runId: "qualified-joint", producerCommit: readCurrentExtractionAuthorityRevision().split(":")[1]! });
      const queryCache = join(directory, "q-cache"), template = jointQuery();
      const queryWorkset = parseSemanticProposalWorkset({ ...PRODUCER, contract: "source-semantic-proposal-workset-v3", kind: "query",
        items: [{ original_query: JOINT_QUESTION }] });
      // Preserve the existing authored rule coordinates through the actual nested-meaning receiver.
      const query = await authoredProposal(queryWorkset, queryCache, () => interpretedQueryRaw({
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, requested_operation: template.requested_operation, gaps: [],
        entities: template.variables.filter(v => v.sort === "entity").map(v => v.id === "module"
          ? { kind: "named", key: v.id, excerpt: "M7" } : { kind: "free", key: v.id, excerpt: JOINT_QUESTION }),
        alternatives: [{ conditions: [], evidence_inputs: template.alternatives[0]!.evidence_inputs!.map(input => ({
          conditions: input.frames.map(id => {
            const frame = template.alternatives[0]!.frames.find(f => f.id === id)!;
            return { kind: "statement", key: frame.id, predicate: frame.predicate_reading,
              arguments: frame.role_requirements.map(role => ({ role: role.id,
                target: { kind: "reference", key: role.target_variable }, excerpt: role.support.excerpt })) };
          }) })) }] }));
      if (query.result.received === undefined || !("query" in query.result.received)) throw new Error("received Q required");
      const q = query.result.received.query, cs = new Map<string, SourceSemanticCorrespondence>(), nominees = [];
      for (const source of sources) {
        const record = manifest.sources.find(row => row.record.source_id === source.id)!.record;
        const tuple = { source_id: record.source_id, record_id: record.identity, source_version: record.source_version, content_digest: record.content_digest };
        const descriptor = descriptors.get(source.id);
        let correspondence;
        if (descriptor !== undefined) {
          const cache = join(directory, `c-${source.id}`), workset = parseSemanticProposalWorkset({ ...queryWorkset, kind: "semantic_correspondence",
            items: [{ original_query: JOINT_QUESTION, admitted_query_semantics: q,
              source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: descriptor.interpretation }] }] });
          const c = await authoredProposal(workset, cache, prompt => {
            const request = JSON.parse(prompt) as SourceSemanticCorrespondenceRequest;
            return correspondenceAssessmentJson({ ...request, producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
              producer_version: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION },
            jointCorrespondence(descriptor.interpretation_id, source.id === "a", q));
          });
          if (c.result.received === undefined || !("semantic_correspondence" in c.result.received) ||
              c.result.received.semantic_correspondence === undefined) throw new Error("received C required");
          cs.set(source.id, c.result.received.semantic_correspondence);
          correspondence = { artifact: c.artifact, workset, cache_root: cache, max_output_tokens: TOKENS };
        }
        nominees.push({ nominee: tuple, current: tuple, body_bytes: Buffer.byteLength(source.text),
          ...(descriptor === undefined ? {} : { interpretation: descriptor }), ...(correspondence === undefined ? {} : { correspondence }) });
      }
      const input: SourceAcquisitionExperimentInput = { contract: "source-acquisition-experiment-v1", root, original_query: JOINT_QUESTION,
        qualified_selection: { contract: "private-qualified-source-selection-v1", query_as_of: null,
          snapshot_identity: manifest.identity, snapshot_source_count: sources.length, query: query.artifact, nominees },
        joint_selection: jointSelection(cs.get("a")!, cs.get("z")!, targets.get("a")!, targets.get("z")!),
        host_admission: { total_work_units: 100, total_memory_bytes: 100, read_work_units: 1, read_memory_bytes: 1,
          max_input_bytes_per_read: 32 * 1024 * 1024, max_read_admissions: 16, max_effects: 1 },
        guard_allocation: { source_inputs: 0, utf8_bytes: 0 }, timeout_ms: 60000, launch: await captureSourceAcquisitionLaunchBinding(),
        config: { snapshot_path: snapshot, snapshot_sha256: manifest.db_sha256, implementation_revision: readCurrentExtractionAuthorityRevision(),
          interpretation_clock: CLOCK, workspace_id: WS, run_id: "qualified-joint", authorized_scopes: { mode: "named", scopes: ["project"] },
          query_workset: queryWorkset, query_cache_root: queryCache, correspondence_cache_root: join(directory, "unused-c-cache"),
          max_output_tokens: TOKENS, discovery_page_cap: 1, correspondence_pair_cap: 16,
          access_policy: "query-conditioned-v1", budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 } };
      mkdirSync(root, { recursive: true });
      await body({ input, sources });
    }, { publicationBudget: { work_units: 100_000_000, memory_bytes: 2_000_000_000 }, onPublicationBoundary(event) {
      if (event.kind !== "end" || event.outcome.status !== "published") return;
      const published = event.outcome.result, h = published.bound.interpretation;
      targets.set(event.source_id, published.bound.source_target);
      descriptors.set(event.source_id, { interpretation_id: published.bound.interpretation_id, source_id: event.source_id,
        source_version: h.source.source_version, content_digest: h.source.content_digest, producer_id: h.producer_id,
        producer_version: h.producer_version, contract_version: h.contract_version, interpretation: h,
        source_disclosure: projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: CLOCK, source: published.source_record }) });
    } });
  } finally { process.execArgv.splice(process.execArgv.lastIndexOf(GUARD), 1); }
}
