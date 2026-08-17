import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { publishBytesExclusiveDurable } from
  "../../bench/extraction/fill/manifest/durable-exclusive-publication.js";

interface DurableExclusiveOutputInput {
  readonly outputPath: string;
  readonly contents: string;
  readonly ownershipId: string;
}

const MAX_DURABLE_OUTPUT_BYTES = 64 * 1024;

/** Caller must hold the write lease that exclusively owns ownershipId. */
export function publishDurableExclusiveOutputUnderLease(
  input: DurableExclusiveOutputInput
): string {
  assertOwnershipId(input.ownershipId);
  const bytes = Buffer.from(input.contents, "utf8");
  if (bytes.byteLength > MAX_DURABLE_OUTPUT_BYTES) {
    throw new Error("durable external output exceeds the 64 KiB limit");
  }
  const target = canonicalOutputPath(input.outputPath);
  try {
    publishBytesExclusiveDurable({
      destination: target,
      bytes,
      ownerIdentity: input.ownershipId,
      temporaryDirectory: dirname(target),
      allowExistingExact: true
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("published destination ")) {
      throw new Error("materialization receipt already exists with different authority", {
        cause
      });
    }
    throw cause;
  }
  return target;
}

function canonicalOutputPath(path: string): string {
  const absolute = resolve(path);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

function assertOwnershipId(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("durable output ownership id must be a sha256 digest");
  }
}
