import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { type SourceSemanticAccessProfile } from "@do-soul/alaya-protocol";
import { sourceSemanticAccessInputIdentity } from "../../../recall/runtime/source-semantic-access.js";
import { sourceSemanticLibraryRequestIdentity } from "../../../recall/runtime/source-semantic-library-recall.js";

const budget = { schema_version: 1 as const, work_units: 20_000, memory_bytes: 8_000_000,
  page_budget: 5, finalization_reserve: 1, min_envelope: 1 };
const access = { original_query: "Which port?", budget, policy: "query-conditioned-v1" as const };
const request = { workspace_id: "workspace", as_of: "2026-10-21T00:00:00Z", authorized_scopes: ["project", "global_core"],
  original_query: "Which port?", query_semantics_status: { status: "unavailable" as const, reason: "absent" as const },
  semantic_correspondences: [], budget, output_byte_limit: 19_392, access_policy: "query-conditioned-v1" as const };
const profile: SourceSemanticAccessProfile = { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7",
  protocol_version: 9, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
  channels: "dual", declared_allowance: { max_attempts: 32, max_roots: 24, max_vector_windows: 4096 } };
const { policy: _policy, ...accessInputs } = access;
const { access_policy: _accessPolicy, ...requestInputs } = request;
const accessWith = (candidate_profile: SourceSemanticAccessProfile) => ({ ...accessInputs, candidate_profile });
const requestWith = (candidate_profile: SourceSemanticAccessProfile) => ({ ...requestInputs, candidate_profile });

it("preserves frozen legacy identities and their independent literal preimages", () => {
  // These literals pin the pre-migration owner, including its non-JSON undefined scalar convention.
  const preimage = '{"budget":{"finalization_reserve":1,"memory_bytes":8000000,"min_envelope":1,"page_budget":5,"schema_version":1,"work_units":20000},"original_query":"Which port?","policy":"query-conditioned-v1","query_semantics":undefined,"resource_contract":"empty-interpretation-reserve-v1","source_id":undefined}';
  const library = '{"access_policy":"query-conditioned-v1","as_of":"2026-10-21T00:00:00Z","authorized_scopes":["global_core","project"],"budget":{"finalization_reserve":1,"memory_bytes":8000000,"min_envelope":1,"page_budget":5,"schema_version":1,"work_units":20000},"original_query":"Which port?","output_byte_limit":19392,"query_semantics":null,"query_semantics_status":{"reason":"absent","status":"unavailable"},"semantic_correspondences":[],"source_id":null,"workspace_id":"workspace"}';
  const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  expect(hash(preimage)).toBe("sha256:dfc27178a949a52dbb51bb5bb944a38e400b23e697391c670e0e3c0ac22fef75");
  expect(sourceSemanticAccessInputIdentity(access)).toBe(hash(preimage));
  expect(sourceSemanticAccessInputIdentity({ ...access, contract: "source-semantic-access-v2" }))
    .toBe("sha256:a65430a12ad6cff19beffc463731da3b29cba5b9382e88f128860662cff8a8f9");
  expect(hash(library)).toBe("sha256:9fc375eabd886337570e5d6e7c623ab83232e53046d3463874faee322379914e");
  expect(sourceSemanticLibraryRequestIdentity(request)).toBe(hash(library));
});

it("binds candidate family, order, acquisition, channels and every declared allowance at the existing owners", () => {
  const accessIdentity = sourceSemanticAccessInputIdentity(accessWith(profile));
  const requestIdentity = sourceSemanticLibraryRequestIdentity(requestWith(profile));
  expect(accessIdentity).not.toBe(sourceSemanticAccessInputIdentity({ ...access, contract: "source-semantic-access-v2" }));
  expect(requestIdentity).not.toBe(sourceSemanticLibraryRequestIdentity(request));
  const changes: readonly Partial<SourceSemanticAccessProfile>[] = [
    { order_policy: "query-conditioned-v1" }, { order_policy: "canonical-v1" },
    { acquisition_policy: "source-index-interleaved-prefix.v1" }, { channels: "lexical" }, { channels: "vector" },
    { declared_allowance: { ...profile.declared_allowance, max_attempts: 31 } },
    { declared_allowance: { ...profile.declared_allowance, max_roots: 16 } },
    { declared_allowance: { ...profile.declared_allowance, max_vector_windows: 4095 } }
  ];
  for (const change of changes) {
    expect(sourceSemanticAccessInputIdentity(accessWith({ ...profile, ...change }))).not.toBe(accessIdentity);
    expect(sourceSemanticLibraryRequestIdentity(requestWith({ ...profile, ...change }))).not.toBe(requestIdentity);
  }
  expect(sourceSemanticLibraryRequestIdentity({ ...requestWith(structuredClone(profile)), authorized_scopes: ["global_core", "project"] }))
    .toBe(requestIdentity);
  expect(sourceSemanticAccessInputIdentity(accessWith(structuredClone(profile)))).toBe(accessIdentity);
  expect(sourceSemanticLibraryRequestIdentity({ ...requestWith(profile), access_policy: undefined })).toBe(requestIdentity);
});

it("rejects null, mixed public policy and cross-family profile material rather than hashing it", () => {
  for (const invalid of [null, { ...profile, contract: "source-semantic-access-v2" },
    { ...profile, result_version: "source-semantic-library-v6" }, { ...profile, protocol_version: 8 },
    { ...profile, access_policy: "query-conditioned-v1" }]) {
    const candidate_profile = invalid as SourceSemanticAccessProfile;
    expect(() => sourceSemanticAccessInputIdentity(accessWith(candidate_profile))).toThrow();
    expect(() => sourceSemanticLibraryRequestIdentity(requestWith(candidate_profile))).toThrow();
  }
  expect(() => sourceSemanticAccessInputIdentity({ ...access, candidate_profile: profile } as unknown as
    Parameters<typeof sourceSemanticAccessInputIdentity>[0])).toThrow(/legacy access policy/u);
  expect(() => sourceSemanticLibraryRequestIdentity({ ...request, candidate_profile: profile } as unknown as
    Parameters<typeof sourceSemanticLibraryRequestIdentity>[0])).toThrow(/public access policy/u);
});
