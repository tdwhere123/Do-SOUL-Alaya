import { createHash } from "node:crypto";
import {
  readSync, type BigIntStats
} from "node:fs";
import {
  readBoundedStableRegularFile, withBoundedStableRegularFile
} from "../bounded-artifact-reader.js";
import { writeBytesExclusiveDurable } from
  "../../fill/manifest/durable-exclusive-publication.js";

const TRANSFER_BUFFER_BYTES = 64 * 1024;

export interface StableFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export function matchStableRegularFileNoFollow(
  path: string,
  expected: Uint8Array,
  maxBytes: number
): StableFileIdentity {
  return withBoundedStableRegularFile({ path, maxBytes, label: "source manifest" },
    (descriptor, opened) => {
    if (opened.size !== BigInt(expected.byteLength)) {
      throw new Error("live source manifest changed since audit");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(TRANSFER_BUFFER_BYTES);
    let offset = 0;
    while (offset < expected.byteLength) {
      const length = Math.min(buffer.length, expected.byteLength - offset);
      const bytesRead = readSync(descriptor, buffer, 0, length, offset);
      if (bytesRead !== length || !buffer.subarray(0, length).equals(
        Buffer.from(expected.buffer, expected.byteOffset + offset, length)
      )) throw new Error("live source manifest changed since audit");
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
    return identity(opened, hash.digest("hex"));
  });
}

export function readStableRegularFileNoFollow(path: string, maxBytes: number): {
  readonly bytes: Buffer;
  readonly identity: StableFileIdentity;
} {
  return readBoundedStableRegularFile({ path, maxBytes, label: "cache shard" });
}

export function writeAllExclusive(path: string, bytes: Uint8Array): void {
  writeBytesExclusiveDurable(path, bytes);
}

function identity(stat: BigIntStats, sha256: string): StableFileIdentity {
  return {
    device: stat.dev.toString(), inode: stat.ino.toString(),
    byteLength: Number(stat.size), sha256
  };
}
