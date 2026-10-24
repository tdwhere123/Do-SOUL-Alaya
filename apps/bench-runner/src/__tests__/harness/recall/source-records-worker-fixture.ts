import { join } from "node:path";
import Database from "better-sqlite3";
import { expect } from "vitest";
import { SourceIndexLifecycle, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository, StorageDatabase } from "@do-soul/alaya-storage";
import type { SoulMemorySearchRequest, SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import type { BenchDaemonHandle } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { BENCH_DAEMON_DB_FILENAME } from "../../../runs/snapshot/materialize.js";
import { BUDGET, configuration } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";

/** Admission/checkpoint retains truth, not query readiness. Prepare real lexical
 * documents explicitly, without vectors, inference, or a fabricated ready flag. */
export function prepareSourceRecordLexicalIndex(dataDir: string, workspaceId: string): void {
  const filename = join(dataDir, BENCH_DAEMON_DB_FILENAME);
  const database = new StorageDatabase(filename, new Database(filename));
  try {
    const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const lifecycle = new SourceIndexLifecycle(repository, fieldContractSha256);
    const generation = lifecycle.begin(lifecycle.select(workspaceId, configuration()));
    const captured = lifecycle.capture(workspaceId, generation.generation_id, 128, BUDGET);
    expect(captured.generation.enumeration_complete).toBe(true);
    const targets = repository.listTargets(workspaceId, generation.generation_id, null, 128);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(lifecycle.prepare(workspaceId, generation.generation_id, target.root_key, BUDGET).status).toBe("ready");
    }
    // Lexical text is model-independent; no vector generation is activated.
    lifecycle.unbind(workspaceId);
    expect(repository.state(workspaceId)).toMatchObject({ status: "unbound", active_generation_id: null });
  } finally { database.close(); }
}

/** Advance only server-issued pages; an exhausted cursor is not logical closure. */
export async function recallSourcePages(daemon: BenchDaemonHandle, request: SoulMemorySearchRequest, maxPages = 20) {
  const pages: SoulMemorySearchResponse[] = [];
  let page = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
  pages.push(page);
  while (page.index?.continuation != null) {
    expect(pages.length).toBeLessThan(maxPages);
    page = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", {
      ...request, continuation: page.index.continuation
    });
    pages.push(page);
  }
  expect(page.index).toBeDefined();
  return { pages, response: page, results: pages.flatMap(row => row.results) };
}
