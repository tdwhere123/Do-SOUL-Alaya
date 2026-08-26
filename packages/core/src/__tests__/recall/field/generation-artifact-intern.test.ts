import { describe, expect, it } from "vitest";

import { digestRecallFieldIdentity } from "../../../recall/field/field-identity.js";
import {
  internProjectionGenerationArtifacts,
  INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT,
  rehydrateProjectionGenerationArtifacts
} from "../../../recall/field/retrieval/projection/generation-artifact-intern.js";
import {
  createProjectionGenerationArtifacts,
  digestProjectionArtifacts,
  parseProjectionGenerationArtifacts
} from "../../../recall/field/retrieval/projection/generation-artifacts.js";
import type {
  SourceProjectionSliceKey,
  SourceProjectionState
} from "../../../recall/field/retrieval/projection/source-projection.js";
import { createSelectedSliceKeyV2 } from
  "../../../recall/flood/slice-key-contract.js";

const GENERATION_ID = "generation-1";
const POLICY = Object.freeze({
  materialize: false,
  maxLevel: 1,
  maxMembers: 16,
  minMembers: 2
});
const CLOCK_MS = Date.parse("2026-08-16T00:00:00.000Z");

describe("projection generation artifact intern", () => {
  it("interns duplicate source_state once and rehydrates a shared reference", () => {
    const first = sourceState();
    const second = { ...first, governance_effects: [...first.governance_effects] };
    const interned = internProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", first),
      sourceKey("evidence-b", "lovelace", second)
    ]));
    const rehydrated = rehydrateProjectionGenerationArtifacts(interned);
    const left = rehydrated.slice_keys[0] as SourceProjectionSliceKey;
    const right = rehydrated.slice_keys[1] as SourceProjectionSliceKey;

    expect(interned.artifacts_format).toBe(INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT);
    expect(Object.keys(interned.source_states)).toHaveLength(1);
    expect(interned.slice_keys.map((key) => key.source_state_id)).toEqual([
      interned.slice_keys[0]?.source_state_id,
      interned.slice_keys[0]?.source_state_id
    ]);
    expect(
      (JSON.parse(JSON.stringify(interned)).slice_keys[0] as { source_state?: unknown })
        .source_state
    ).toBeUndefined();
    expect(left.source_state).toEqual(first);
    expect(left.source_state).toBe(right.source_state);
  });

  it("digests interned canonical form and rehydrated consumer objects equally", () => {
    const artifacts = createProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", sourceState())
    ]));
    const interned = internProjectionGenerationArtifacts(artifacts);

    expect(digestProjectionArtifacts(interned)).toBe(artifacts.artifact_digest);
    expect(digestProjectionArtifacts(artifacts)).toBe(artifacts.artifact_digest);
    expect(digestRecallFieldIdentity(interned)).toBe(artifacts.artifact_digest);
  });

  it("round-trips interned JSON through parse with source_state restored", () => {
    const state = sourceState();
    const artifacts = createProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", state)
    ]));
    const interned = internProjectionGenerationArtifacts(artifacts);
    const parsed = parseProjectionGenerationArtifacts(
      JSON.parse(JSON.stringify(interned)),
      artifacts.generation_id,
      artifacts.artifact_digest
    );
    const key = parsed.slice_keys[0] as SourceProjectionSliceKey;

    expect(parsed.artifact_digest).toBe(artifacts.artifact_digest);
    expect(key.source_state).toEqual(state);
    expect("source_state_id" in key).toBe(false);
  });

  it("is idempotent for interned and rehydrated graphs", () => {
    const artifacts = createProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", sourceState()),
      sourceKey("evidence-b", "lovelace", sourceState())
    ]));
    const interned = internProjectionGenerationArtifacts(artifacts);

    expect(internProjectionGenerationArtifacts(interned)).toEqual(interned);
    expect(internProjectionGenerationArtifacts(artifacts)).toEqual(interned);
    expect(JSON.stringify(internProjectionGenerationArtifacts(interned)))
      .toBe(JSON.stringify(interned));
  });

  it("leaves slice keys without source_state unchanged", () => {
    const key = createSelectedSliceKeyV2(keyInput("memory-1", "Ada Lovelace"));
    const interned = internProjectionGenerationArtifacts(graphOf([key]));

    expect(interned.source_states).toEqual({});
    expect(interned.slice_keys[0]).toEqual(key);
    expect("source_state_id" in (interned.slice_keys[0] ?? {})).toBe(false);
  });

  it("remints a stored expanded-graph digest into interned consumer artifacts", () => {
    const state = sourceState();
    const artifacts = createProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", state)
    ]));
    const expanded = {
      generation_id: artifacts.generation_id,
      postings: artifacts.postings,
      bundles: artifacts.bundles,
      slice_keys: artifacts.slice_keys,
      policy: artifacts.policy
    };
    const oldDigest = digestRecallFieldIdentity(expanded);
    const parsed = parseProjectionGenerationArtifacts(
      expanded,
      artifacts.generation_id,
      oldDigest
    );
    const key = parsed.slice_keys[0] as SourceProjectionSliceKey;

    expect(oldDigest).not.toBe(artifacts.artifact_digest);
    expect(parsed.artifact_digest).toBe(artifacts.artifact_digest);
    expect(key.source_state).toEqual(state);
    expect("source_state_id" in key).toBe(false);
  });

  it("rejects interned JSON paired with an expanded-graph digest", () => {
    const artifacts = createProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", sourceState())
    ]));
    const interned = internProjectionGenerationArtifacts(artifacts);
    const oldDigest = digestRecallFieldIdentity({
      generation_id: artifacts.generation_id,
      postings: artifacts.postings,
      bundles: artifacts.bundles,
      slice_keys: artifacts.slice_keys,
      policy: artifacts.policy
    });

    expect(() => parseProjectionGenerationArtifacts(
      interned,
      artifacts.generation_id,
      oldDigest
    )).toThrow(/digest mismatch/u);
  });

  it("rejects a legacy expanded artifact with malformed source_state", () => {
    const artifacts = createProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", sourceState())
    ]));
    const expanded = {
      generation_id: artifacts.generation_id,
      postings: artifacts.postings,
      bundles: artifacts.bundles,
      slice_keys: artifacts.slice_keys.map((key) => ({ ...key, source_state: null })),
      policy: artifacts.policy
    };
    const oldDigest = digestRecallFieldIdentity(expanded);

    expect(() => parseProjectionGenerationArtifacts(
      expanded,
      artifacts.generation_id,
      oldDigest
    )).toThrow(/persisted projection generation artifacts are invalid/u);
  });

  it("rejects interned slice keys that only declare key_id and schema_version", () => {
    expect(() => internProjectionGenerationArtifacts(graphOf([
      { key_id: "k", schema_version: 2 } as never
    ]))).toThrow(/persisted projection generation artifacts are invalid/u);
  });

  it("rejects an interned key whose source_state_id is missing", () => {
    const interned = internProjectionGenerationArtifacts(graphOf([
      sourceKey("evidence-a", "ada", sourceState())
    ]));
    const broken = {
      ...interned,
      slice_keys: interned.slice_keys.map((key) => ({
        ...key,
        source_state_id: "missing-state"
      }))
    };

    expect(() => internProjectionGenerationArtifacts(broken))
      .toThrow(/persisted projection generation artifacts are invalid/u);
  });
});

function graphOf(sliceKeys: readonly ReturnType<typeof sourceKey>[] | readonly ReturnType<
  typeof createSelectedSliceKeyV2
>[]) {
  return {
    generation_id: GENERATION_ID,
    postings: [],
    bundles: [],
    slice_keys: sliceKeys,
    policy: POLICY
  };
}

function sourceKey(
  ownerId: string,
  value: string,
  state: SourceProjectionState
): SourceProjectionSliceKey {
  return Object.freeze({
    ...createSelectedSliceKeyV2(keyInput(ownerId, value)),
    source_state: state
  });
}

function keyInput(ownerId: string, value: string) {
  return {
    workspace_id: "workspace-1",
    owner_id: ownerId,
    dimension: "semantic" as const,
    value,
    authority: "grounded" as const,
    reliability: 1,
    independence_group: `source:${ownerId}`,
    provenance: { kind: "signal_fact" as const, source_ref: `span:${ownerId}` },
    source_version: "source-v1",
    freshness: { state: "fresh" as const, as_of_ms: CLOCK_MS }
  };
}

function sourceState(): SourceProjectionState {
  return Object.freeze({
    scope: "workspace-1",
    event_time: null,
    valid_from: null,
    valid_to: null,
    lifecycle_state: "active",
    governance_state: "ordinary_evidence",
    sealed: false,
    erased: false,
    revoked: false,
    governance_effects: Object.freeze([])
  });
}
