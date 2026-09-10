import type { StorageDatabase } from "../../sqlite/db.js";
import { retainedSourceChunkDigest } from "../../sqlite/retained-source-chunk-digest.js";

export const RETAINED_SOURCE_CHUNK_BYTES = 4096;
export const RETAINED_SOURCE_METADATA_BYTES = 8192;
export const RETAINED_SOURCE_READ_RESERVATION = RETAINED_SOURCE_CHUNK_BYTES + RETAINED_SOURCE_METADATA_BYTES;

type ChunkIdentity = Readonly<{
  workspaceId: string;
  kind: "source_record" | "evidence_capsule";
  rootId: string;
  revision: string;
  digest: string;
}>;

/** Derived bytes are written only alongside their canonical retained source. */
export function writeRetainedSourceChunks(database: Pick<StorageDatabase, "connection">, identity: ChunkIdentity, content: string): void {
  const bytes = Buffer.from(content, "utf8");
  database.connection.prepare(`DELETE FROM retained_source_chunks
    WHERE workspace_id = ? AND root_kind = ? AND root_id = ?`).run(identity.workspaceId, identity.kind, identity.rootId);
  const insert = database.connection.prepare(`INSERT INTO retained_source_chunks
    (workspace_id, root_kind, root_id, source_revision, content_digest, start_offset, body, body_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + RETAINED_SOURCE_CHUNK_BYTES);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    insert.run(identity.workspaceId, identity.kind, identity.rootId, identity.revision, identity.digest,
      start, bytes.subarray(start, end), chunkDigest(identity, start, bytes.subarray(start, end)));
    start = end;
  }
}

export function readRetainedSourceChunk(database: StorageDatabase, identity: ChunkIdentity,
  offset: number, byteLimit: number, bodyBytes: number): Readonly<{ prefix: Buffer | null; nativeBytes: number; metadataBytes: number }> {
  if (offset === bodyBytes) return { prefix: Buffer.alloc(0), nativeBytes: 0, metadataBytes: 0 };
  if (offset > bodyBytes) return { prefix: null, nativeBytes: 0, metadataBytes: 0 };
  const chunk = database.connection.prepare(`SELECT start_offset, body, body_digest FROM retained_source_chunks
    WHERE workspace_id = ? AND root_kind = ? AND root_id = ? AND source_revision = ? AND content_digest = ?
      AND start_offset <= ? ORDER BY start_offset DESC LIMIT 1`).get(identity.workspaceId, identity.kind,
    identity.rootId, identity.revision, identity.digest, offset) as { start_offset: number; body: Buffer; body_digest: string } | undefined;
  if (chunk === undefined) return { prefix: null, nativeBytes: 0, metadataBytes: 0 };
  if (!Buffer.isBuffer(chunk.body) || chunk.body.length > RETAINED_SOURCE_CHUNK_BYTES
    || chunkDigest(identity, chunk.start_offset, chunk.body) !== chunk.body_digest) {
    return { prefix: null, nativeBytes: Buffer.byteLength(chunk.body), metadataBytes: 72 };
  }
  const local = offset - chunk.start_offset;
  return { prefix: local >= chunk.body.length ? null : chunk.body.subarray(local, local + byteLimit),
    nativeBytes: chunk.body.length, metadataBytes: 72 };
}

function chunkDigest(identity: ChunkIdentity, start: number, bytes: Buffer): string {
  return retainedSourceChunkDigest(identity.workspaceId, identity.kind, identity.rootId, identity.revision, identity.digest, start, bytes);
}
