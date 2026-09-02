import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sealSemanticArtifact,
  type SemanticArtifactUnsigned
} from "../../../runs/extraction/cache/semantic-artifact/contract.js";
import {
  admitSemanticArtifact,
  inspectSemanticArtifact,
  listSemanticArtifactInventory,
  releaseSemanticArtifactReservation,
  reserveSemanticArtifact,
  semanticArtifactPath
} from "../../../runs/extraction/cache/semantic-artifact/store.js";

const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);
const CAP = "official_api_signals:v1";
const CAP_B = "temporal_validity:v1";

function unsigned(
  overrides: Partial<SemanticArtifactUnsigned> = {}
): SemanticArtifactUnsigned {
  return {
    schema_version: 1,
    kind: "assertion_semantic_artifact_v1",
    semantic_key: KEY,
    semantic_contract: "alaya.assertion_semantic_identity.v1",
    capability: CAP,
    capability_set: [CAP],
    model_family: "mimo-v2.5",
    model_id: "mimo-v2.5",
    admission_state: "provider_backed",
    source_bindings: [{
      semanticKey: KEY,
      sourceCorpusIdentity: "11".repeat(32),
      sourceTextDigest: "22".repeat(32),
      locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1,
        start: 0,
        end: 12
      }
    }],
    raw_response_digest: "33".repeat(32),
    provider_provenance: {
      provider_url_sha256: "44".repeat(32),
      request_profile: "mimo-v2.5-nonthinking-v1",
      model_id: "mimo-v2.5"
    },
    ...overrides
  };
}

describe("semantic artifact store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "semantic-artifact-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a provider-backed artifact independently of transport partition", async () => {
    const artifact = sealSemanticArtifact(unsigned());
    const token = reserveSemanticArtifact(root, KEY, CAP);
    admitSemanticArtifact({ root, artifact, reservationToken: token });
    const inspected = inspectSemanticArtifact(root, KEY, CAP);
    expect(inspected.status).toBe("provider_backed");
    expect(inspected.artifact?.artifact_digest).toBe(artifact.artifact_digest);
    expect(inspected.artifact?.source_bindings).toHaveLength(1);
  });

  it("fails closed on crash-before-rename, truncated JSON, digest mismatch, and symlink", () => {
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("missing");
    const token = reserveSemanticArtifact(root, KEY, CAP);
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("reserved");
    const path = semanticArtifactPath(root, KEY, CAP);
    mkdirSync(join(root, ".tmp"), { recursive: true });
    writeFileSync(join(root, ".tmp", ".alaya-exclusive-publication-crash.tmp"), "{", "utf8");
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("reserved");
    expect(existsSync(path)).toBe(false);
    releaseSemanticArtifactReservation(root, KEY, CAP, token);

    writeFileSync(path, "{not json\n", "utf8");
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("invalid");

    const sealed = sealSemanticArtifact(unsigned());
    writeFileSync(path, `${JSON.stringify({ ...sealed, artifact_digest: "00".repeat(32) })}\n`, "utf8");
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("invalid");

    rmSync(path, { force: true });
    symlinkSync(join(root, "missing-target.json"), path);
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("invalid");
  });

  it("rejects a second writer and a stale token", () => {
    const first = reserveSemanticArtifact(root, KEY, CAP);
    expect(() => reserveSemanticArtifact(root, KEY, CAP)).toThrow(/reservation is held/u);
    const artifact = sealSemanticArtifact(unsigned());
    expect(() => admitSemanticArtifact({
      root,
      artifact,
      reservationToken: "not-the-token"
    })).toThrow(/token mismatch/u);
    admitSemanticArtifact({ root, artifact, reservationToken: first });
    expect(() => reserveSemanticArtifact(root, KEY, CAP)).toThrow(/already admitted/u);
  });

  it("does not parse provider-empty without exhaustive proof as deterministic empty", () => {
    expect(() => sealSemanticArtifact(unsigned({
      admission_state: "deterministic_empty",
      raw_response_digest: undefined,
      deterministic_empty_proof: undefined
    }))).toThrow(/exhaustive proof/u);
    const empty = sealSemanticArtifact(unsigned({
      admission_state: "deterministic_empty",
      raw_response_digest: undefined,
      provider_provenance: undefined,
      deterministic_empty_proof: {
        kind: "zero_assertion_catalog",
        formation_contract_version: 2,
        catalog_assertion_count: 0
      }
    }));
    const token = reserveSemanticArtifact(root, KEY, CAP);
    admitSemanticArtifact({ root, artifact: empty, reservationToken: token });
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("deterministic_empty");
  });

  it("keeps unrelated capabilities when one capability is admitted", () => {
    const first = sealSemanticArtifact(unsigned());
    const tokenA = reserveSemanticArtifact(root, KEY, CAP);
    admitSemanticArtifact({ root, artifact: first, reservationToken: tokenA });
    expect(inspectSemanticArtifact(root, KEY, CAP_B).status).toBe("missing");
    const second = sealSemanticArtifact(unsigned({
      capability: CAP_B,
      capability_set: [CAP_B],
      semantic_key: KEY
    }));
    const tokenB = reserveSemanticArtifact(root, KEY, CAP_B);
    admitSemanticArtifact({ root, artifact: second, reservationToken: tokenB });
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("provider_backed");
    expect(inspectSemanticArtifact(root, KEY, CAP_B).status).toBe("provider_backed");
    expect(listSemanticArtifactInventory(root)).toHaveLength(2);
  });

  it("rejects mixed source bindings and foreign capability identity", () => {
    expect(() => sealSemanticArtifact(unsigned({
      source_bindings: [{
        semanticKey: OTHER_KEY,
        sourceCorpusIdentity: "11".repeat(32),
        sourceTextDigest: "22".repeat(32),
        locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: 1,
          start: 0,
          end: 4
        }
      }]
    }))).toThrow(/semantic key mismatch/u);
  });

  it("treats eviction as availability loss only", () => {
    const artifact = sealSemanticArtifact(unsigned({ semantic_key: OTHER_KEY, source_bindings: [{
      semanticKey: OTHER_KEY,
      sourceCorpusIdentity: "11".repeat(32),
      sourceTextDigest: "22".repeat(32),
      locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1,
        start: 0,
        end: 4
      }
    }] }));
    const token = reserveSemanticArtifact(root, OTHER_KEY, CAP);
    admitSemanticArtifact({ root, artifact, reservationToken: token });
    expect(listSemanticArtifactInventory(root)).toHaveLength(1);
    writeFileSync(semanticArtifactPath(root, OTHER_KEY, CAP), "", "utf8");
    expect(inspectSemanticArtifact(root, OTHER_KEY, CAP).status).toBe("invalid");
    expect(listSemanticArtifactInventory(root)).toHaveLength(0);
  });
});
