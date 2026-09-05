import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishBytesExclusiveDurable } from
  "../../../runs/extraction/fill/manifest/durable-exclusive-publication.js";

describe("durable exclusive publication", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("replaces a truncated exclusive temporary left by a crashed writer", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-exclusive-publication-"));
    roots.push(root);
    const destination = join(root, "published.bin");
    const temporaryDirectory = join(root, "tmp");
    mkdirSync(temporaryDirectory);
    const bytes = Buffer.from("complete-payload");
    const ownerIdentity = "catalog-refill";
    const identity = createHash("sha256")
      .update(destination).update("\0")
      .update(ownerIdentity).update("\0")
      .update(bytes)
      .digest("hex");
    writeFileSync(
      join(temporaryDirectory, `.alaya-exclusive-publication-${identity}.tmp`),
      "trunc"
    );

    publishBytesExclusiveDurable({
      destination, bytes, ownerIdentity, temporaryDirectory
    });

    expect(readFileSync(destination)).toEqual(bytes);
  });
});
