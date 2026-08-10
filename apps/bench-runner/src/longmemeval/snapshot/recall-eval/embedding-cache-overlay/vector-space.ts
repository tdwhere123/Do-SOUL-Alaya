import BetterSqlite3 from "better-sqlite3";
import type {
  EmbeddingCacheOverlayExpectedSourceBinding,
  EmbeddingCacheOverlaySourceBinding
} from "./contract.js";

export function bindEmbeddingCacheOverlayDimensions(input: {
  readonly warmedDbPath: string;
  readonly expected: EmbeddingCacheOverlayExpectedSourceBinding;
}): EmbeddingCacheOverlaySourceBinding {
  const database = new BetterSqlite3(input.warmedDbPath, {
    readonly: true,
    fileMustExist: true
  });
  try {
    const vector = input.expected.vector_space;
    const rows = database.prepare(DIMENSIONS_SQL).pluck().all(
      vector.provider_kind,
      vector.model_id,
      vector.schema_version,
      vector.provider_kind,
      vector.model_id,
      vector.schema_version
    ) as number[];
    const dimensions = [...new Set(rows)];
    if (dimensions.length !== 1 || !Number.isSafeInteger(dimensions[0]) || dimensions[0]! < 1) {
      throw new Error("embedding cache overlay source must contain one vector dimension");
    }
    if (vector.dimensions !== undefined && vector.dimensions !== dimensions[0]) {
      throw new Error("embedding cache overlay source vector dimensions mismatch runtime");
    }
    return Object.freeze({
      ...input.expected,
      vector_space: Object.freeze({ ...vector, dimensions: dimensions[0]! })
    });
  } finally {
    database.close();
  }
}

const DIMENSIONS_SQL = `
  SELECT dimensions FROM memory_embeddings
  WHERE provider_kind = ? AND model_id = ? AND schema_version = ? AND vector_valid = 1
  UNION
  SELECT dimensions FROM evidence_recall_embeddings
  WHERE provider_kind = ? AND model_id = ? AND schema_version = ? AND vector_valid = 1
  ORDER BY dimensions
`;
