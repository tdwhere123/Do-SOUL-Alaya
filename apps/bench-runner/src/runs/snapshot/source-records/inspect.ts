import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SoulMemorySearchRequestSchema, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../selection/question-runtime-identity.js";
import { restoreSnapshotToDataDir } from "../materialize.js";
import { inspectSourceRecordsArtifact } from "./contract.js";

/** Validate a source artifact, restore a private working copy and use real MCP. */
export async function inspectSourceRecordsSnapshot(input: Readonly<{
  snapshotPath: string; questionId: string; query: string; maxResults?: number; maxPages?: number;
}>): Promise<Readonly<{
  artifact_domain: "source_records"; manifest_sha256: string;
  response: SoulMemorySearchResponse;
  pages: readonly SoulMemorySearchResponse[];
  continuation_state: "exhausted" | "inspection_page_limit";
}>> {
  const snapshotPath = resolve(input.snapshotPath);
  const { manifest, sidecar } = inspectSourceRecordsArtifact(snapshotPath);
  if (!manifest.dataset.question_ids.includes(input.questionId)) throw new Error("question is outside source_records snapshot");
  const maxPages = input.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive safe integer");
  const identity = buildLongMemEvalQuestionRuntimeIdentity(input.questionId);
  const dataDirRoot = await mkdtemp(join(tmpdir(), "alaya-source-records-inspect-"));
  try {
    restoreSnapshotToDataDir({ snapshotDbPath: snapshotPath, dataDirRoot, expectedSha256: manifest.db_sha256 });
    const daemon = await startBenchDaemon({ dataDirRoot, ...identity, embeddingMode: "disabled" });
    try {
      const request = SoulMemorySearchRequestSchema.parse({
        query: input.query, max_results: input.maxResults ?? 20, result_kind_view: "source_only",
        scope_class: null, dimension: null, domain_tags: null,
        source_observed_at: sidecar.questions.find((q) => q.question_id === input.questionId)!.interpretation_clock,
        protocol_version: 1, supports_source_evidence: true,
        supported_result_kinds: ["source_evidence"], supports_product_updates: true
      });
      const pages: SoulMemorySearchResponse[] = [];
      let response = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
      pages.push(response);
      while (response.index?.continuation != null && pages.length < maxPages) {
        response = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", SoulMemorySearchRequestSchema.parse({
          ...request, continuation: response.index.continuation
        }));
        pages.push(response);
      }
      return { artifact_domain: "source_records", manifest_sha256: manifest.manifest_sha256, response, pages,
        continuation_state: response.index?.continuation == null ? "exhausted" : "inspection_page_limit" };
    } finally {
      await daemon.shutdown();
    }
  } finally {
    await rm(dataDirRoot, { recursive: true, force: true });
  }
}
