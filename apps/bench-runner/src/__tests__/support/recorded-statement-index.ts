import { expect } from "vitest";
import { prepareSourceIndexDocument, type SourceIndexConfiguration } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository, type StorageDatabase } from "@do-soul/alaya-storage";

export const RECORDED_STATEMENT_CONFIGURATION: SourceIndexConfiguration = { revision: "recorded-test", profile: {
  provider_kind: "recorded-fixture", model_id: "three-axis", model_revision: "1",
  artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "fixture", dimensions: 3,
  preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 65536,
  windowing: "recorded-message-windows.v1", window_bytes: 65536
} };
const BUDGET = { work: 100000, native_bytes: 16 * 1024 * 1024 };
type IndexedTarget = ReturnType<SqliteSourceIndexRepository["listTargets"]>[number];

/** Exercise actual SQLite preparation with recorded vectors, never an embedding model. */
export function prepareRecordedStatementIndex(database: StorageDatabase, workspace: string,
  embed: (source: IndexedTarget) => readonly number[] = source => source.auxiliary === undefined ? [0, 1, 0] : [1, 0, 0]) {
  const configuration = RECORDED_STATEMENT_CONFIGURATION;
  const index = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const generation = index.begin(index.select(workspace, configuration));
  expect(index.capturePage(workspace, generation.generation_id, 128, BUDGET).generation.enumeration_complete).toBe(true);
  const targets = index.listTargets(workspace, generation.generation_id, null, 128);
  for (const source of targets) {
    const read = index.readDocument(workspace, generation.generation_id, source.root_key, 4 * 1024 * 1024, BUDGET);
    expect(read.status).toBe("ready"); if (read.status !== "ready") throw new Error(read.reason);
    const document = prepareSourceIndexDocument({ source, body: read.body, message_structure: read.message_structure,
      profile: configuration.profile }, fieldContractSha256);
    expect(index.writeDocument(workspace, generation.generation_id, document, BUDGET).status).toBe("accepted");
    for (const window of document.windows) expect(index.writeVector(workspace, generation.generation_id, {
      window_id: window.window_id, input_digest: window.content_digest,
      embedding: new Float32Array(embed(source)), token_count: 3, truncated: false
    }).status).toBe("accepted");
  }
  expect(index.activate(workspace, generation.generation_id)).toEqual({ status: "accepted" });
  return { index, targets, generation };
}
