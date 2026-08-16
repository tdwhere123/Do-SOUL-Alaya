import {
  hashBundleId,
  hashLabeledIdentity,
  PROJECTION_GENERATION_OPERATOR_ID,
  type FieldContractSha256,
  type ProjectionEraseSubjectKind
} from "@do-soul/alaya-protocol";

import {
  assertSingleGeneration,
  type ProjectionL1Posting
} from "../field/retrieval/projection/l1-postings.js";

export type ProjectionFactorSummary = Readonly<{
  readonly dimension: string;
  readonly value: string;
}>;

export type ProjectionL2Bundle = Readonly<{
  readonly bundle_id: string;
  readonly generation_id: string;
  readonly scope: string;
  readonly anchor_digest: string;
  readonly level: number;
  readonly member_refs: readonly string[];
  readonly child_bundle_ids: readonly string[];
  readonly factor_summary: readonly ProjectionFactorSummary[];
  readonly support_lineages: readonly string[];
  readonly unseen_frontier_upper_bound: number;
  readonly opened: boolean;
  readonly operator_id: typeof PROJECTION_GENERATION_OPERATOR_ID;
}>;

export type L2MaterializationPolicy = Readonly<{
  readonly materialize: boolean;
  readonly maxLevel: number;
  readonly maxMembers: number;
  readonly minMembers: number;
}>;

export type PlantedBundleFrontier = Readonly<{
  readonly bundle_id?: string;
  readonly anchor_digest: string;
  readonly unseen_gain_upper_bound: number;
  readonly opened?: boolean;
}>;

export function materializeSliceKeyL2Bundles(params: Readonly<{
  readonly generationId: string;
  readonly postings: readonly ProjectionL1Posting[];
  readonly sha256: FieldContractSha256;
  readonly policy: L2MaterializationPolicy;
  readonly scope?: string;
  readonly plantedFrontiers?: readonly PlantedBundleFrontier[];
}>): readonly ProjectionL2Bundle[] {
  assertSingleGeneration(params.postings);
  if (!params.policy.materialize) return Object.freeze([]);
  const scope = params.scope ?? workspaceScope(params.postings);
  const levelOne = materializeLevelOneBundles(params, scope);
  const higher = params.policy.maxLevel >= 2
    ? materializeLevelTwoBundles(params, scope, levelOne)
    : [];
  return applyPlantedFrontiers(params, scope, Object.freeze([...levelOne, ...higher]));
}

export function assertProjectionBundleLevelDag(
  bundles: readonly ProjectionL2Bundle[]
): void {
  const byId = new Map(bundles.map((bundle) => [bundle.bundle_id, bundle]));
  for (const bundle of bundles) {
    if (bundle.level < 1 || !Number.isSafeInteger(bundle.level)) {
      throw new Error("bundle level DAG is invalid");
    }
    for (const childId of bundle.child_bundle_ids) {
      const child = byId.get(childId);
      if (child === undefined || child.level >= bundle.level) {
        throw new Error("bundle level DAG forbids same-or-higher children");
      }
    }
  }
}

export function applyEraseToL2Bundles(
  bundles: readonly ProjectionL2Bundle[],
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind
): readonly ProjectionL2Bundle[] {
  return Object.freeze(bundles.map((bundle) => Object.freeze({
    ...bundle,
    factor_summary: Object.freeze(bundle.factor_summary.map((factor) =>
      subjectKind === "generation" || factor.value === subjectId
        ? Object.freeze({ ...factor, value: "" })
        : factor
    )),
    support_lineages: Object.freeze(bundle.support_lineages.filter((lineage) =>
      subjectKind === "generation" ? false : lineage !== subjectId
    ))
  })));
}

function materializeLevelOneBundles(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string
): readonly ProjectionL2Bundle[] {
  const groups = groupPostings(params.postings);
  return Object.freeze([...groups.entries()].flatMap(([anchorKey, members]) => {
    const uniqueMembers = uniqueSorted(members);
    if (uniqueMembers.length < params.policy.minMembers) return [];
    const [dimension, value] = splitAnchorKey(anchorKey);
    const anchorDigest = hashLabeledIdentity("bundle_anchor", [
      dimension,
      value
    ], params.sha256);
    return [createBundle(params, scope, {
      anchorDigest,
      level: 1,
      members: uniqueMembers.slice(0, params.policy.maxMembers),
      children: [],
      summary: [Object.freeze({ dimension, value })],
      opened: true,
      unseen: 0
    })];
  }).sort((left, right) => compareText(left.bundle_id, right.bundle_id)));
}

function materializeLevelTwoBundles(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string,
  levelOne: readonly ProjectionL2Bundle[]
): readonly ProjectionL2Bundle[] {
  const pairs: ProjectionL2Bundle[] = [];
  for (let leftIndex = 0; leftIndex < levelOne.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < levelOne.length; rightIndex += 1) {
      const left = levelOne[leftIndex]!;
      const right = levelOne[rightIndex]!;
      if (!sharesMember(left.member_refs, right.member_refs)) continue;
      const members = uniqueSorted([...left.member_refs, ...right.member_refs])
        .slice(0, params.policy.maxMembers);
      pairs.push(createBundle(params, scope, {
        anchorDigest: hashLabeledIdentity("bundle_anchor", [
          left.bundle_id,
          right.bundle_id
        ], params.sha256),
        level: 2,
        members,
        children: [left.bundle_id, right.bundle_id],
        summary: Object.freeze([...left.factor_summary, ...right.factor_summary]),
        opened: true,
        unseen: 0
      }));
    }
  }
  return Object.freeze(pairs.sort((left, right) =>
    compareText(left.bundle_id, right.bundle_id)
  ));
}

function applyPlantedFrontiers(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string,
  bundles: readonly ProjectionL2Bundle[]
): readonly ProjectionL2Bundle[] {
  const planted = params.plantedFrontiers ?? [];
  const byAnchor = new Map(bundles.map((bundle) => [bundle.anchor_digest, bundle]));
  const output = bundles.map((bundle) => {
    const match = planted.find((frontier) => frontier.anchor_digest === bundle.anchor_digest);
    return match === undefined ? bundle : Object.freeze({
      ...bundle,
      unseen_frontier_upper_bound: match.unseen_gain_upper_bound,
      opened: match.opened ?? bundle.opened
    });
  });
  for (const frontier of planted) {
    if (byAnchor.has(frontier.anchor_digest)) continue;
    output.push(createBundle(params, scope, {
      anchorDigest: frontier.anchor_digest,
      level: 1,
      members: [],
      children: [],
      summary: [],
      opened: frontier.opened ?? false,
      unseen: frontier.unseen_gain_upper_bound,
      bundleId: frontier.bundle_id
    }));
  }
  assertProjectionBundleLevelDag(output);
  return Object.freeze(output.sort((left, right) =>
    compareText(left.bundle_id, right.bundle_id)
  ));
}

function createBundle(
  params: Parameters<typeof materializeSliceKeyL2Bundles>[0],
  scope: string,
  input: Readonly<{
    readonly anchorDigest: string;
    readonly level: number;
    readonly members: readonly string[];
    readonly children: readonly string[];
    readonly summary: readonly ProjectionFactorSummary[];
    readonly opened: boolean;
    readonly unseen: number;
    readonly bundleId?: string;
  }>
): ProjectionL2Bundle {
  const bundleId = input.bundleId ?? hashBundleId({
    scope,
    anchor_digest: input.anchorDigest,
    level: input.level,
    operator_id: PROJECTION_GENERATION_OPERATOR_ID,
    generation_id: params.generationId
  }, params.sha256);
  return Object.freeze({
    bundle_id: bundleId,
    generation_id: params.generationId,
    scope,
    anchor_digest: input.anchorDigest,
    level: input.level,
    member_refs: Object.freeze([...input.members]),
    child_bundle_ids: Object.freeze([...input.children]),
    factor_summary: Object.freeze(input.summary.map((factor) => Object.freeze({ ...factor }))),
    support_lineages: Object.freeze([...input.members]),
    unseen_frontier_upper_bound: input.unseen,
    opened: input.opened,
    operator_id: PROJECTION_GENERATION_OPERATOR_ID
  });
}

function groupPostings(
  postings: readonly ProjectionL1Posting[]
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>();
  for (const posting of postings) {
    if (posting.erased || posting.source !== "slice_key") continue;
    const key = `${posting.dimension}\0${posting.normalized_value}`;
    const members = groups.get(key) ?? [];
    members.push(posting.member_ref);
    groups.set(key, members);
  }
  return groups;
}

function workspaceScope(postings: readonly ProjectionL1Posting[]): string {
  return postings[0]?.generation_id ?? "workspace";
}

function splitAnchorKey(anchorKey: string): readonly [string, string] {
  const split = anchorKey.indexOf("\0");
  return [anchorKey.slice(0, split), anchorKey.slice(split + 1)];
}

function sharesMember(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((member) => rightSet.has(member));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
