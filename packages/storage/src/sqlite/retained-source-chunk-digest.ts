import { createHash } from "node:crypto";
import type { SqliteConnection } from "./db.js";

export function retainedSourceChunkDigest(workspace: string, kind: string, root: string, revision: string,
  digest: string, offset: number, body: Buffer): string {
  if (!Buffer.isBuffer(body) || body.length > 4096 || !Number.isSafeInteger(offset) || offset < 0
    || [workspace, kind, root, revision, digest].some((value) => typeof value !== "string")
    || Buffer.byteLength(JSON.stringify([workspace, kind, root, revision, digest]), "utf8") > 8192) {
    throw new Error("invalid retained source chunk identity or capacity");
  }
  return createHash("sha256").update(JSON.stringify(["retained.source.chunk.v1", workspace, kind, root,
    revision, digest, offset])).update(body).digest("hex");
}

export function registerRetainedSourceChunkDigest(connection: SqliteConnection): void {
  connection.function("retained_source_chunk_digest_v1", { deterministic: true }, retainedSourceChunkDigest);
}
