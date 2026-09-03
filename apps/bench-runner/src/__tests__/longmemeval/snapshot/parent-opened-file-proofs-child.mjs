import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const boundFileUrl = pathToFileURL(fileURLToPath(
  new URL("../../../runs/snapshot/bound-file.ts", import.meta.url)
));
const {
  boundFileFullContentReadCount,
  hashRegularFileNoFollow,
  seedRegularFileSha256
} = await import(boundFileUrl.href);

const payload = JSON.parse(process.argv[2] ?? "{}");
const before = boundFileFullContentReadCount();
try {
  for (const [filePath, proof] of Object.entries(payload.proofs ?? {})) {
    seedRegularFileSha256({
      filePath,
      expectedIdentity: proof,
      sha256: proof.sha256
    });
  }
  const sha256s = (payload.hashPaths ?? Object.keys(payload.proofs ?? {})).map(
    (filePath) => hashRegularFileNoFollow(filePath)
  );
  process.stdout.write(JSON.stringify({
    sha256s,
    reads: boundFileFullContentReadCount() - before
  }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
