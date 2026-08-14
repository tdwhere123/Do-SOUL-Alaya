import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PrivateLedgerSource {
  readonly path: string;
  readonly sha256: string;
  dispose(): Promise<void>;
}

export async function snapshotLedgerSource(input: {
  readonly sourcePath: string;
  readonly expectedSha256: string;
  readonly outputPath: string;
  readonly maxBytes: number;
}): Promise<PrivateLedgerSource> {
  const root = await mkdtemp(join(dirname(input.outputPath), ".ledger-source-"));
  const snapshotPath = join(root, "selection-boundaries.ndjson.gz");
  const source = await open(
    input.sourcePath,
    constants.O_RDONLY | requireNoFollow()
  );
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > input.maxBytes) {
      throw new Error("selection order ledger source is not a bounded regular file");
    }
    const bytes = await source.readFile();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== input.expectedSha256) {
      throw new Error("selection order ledger source SHA-256 mismatch");
    }
    const destination = await open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      await destination.writeFile(bytes);
      await destination.sync();
    } finally {
      await destination.close();
    }
    return Object.freeze({
      path: snapshotPath,
      sha256,
      dispose: () => rm(root, { recursive: true, force: true })
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await source.close();
  }
}

function requireNoFollow(): number {
  const noFollow = (constants as Readonly<Record<string, number>>).O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("selection order ledger requires O_NOFOLLOW support");
  }
  return noFollow;
}
