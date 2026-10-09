import { afterAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const guard = "../../../../../core-daemon/src/__tests__/support/provider-free-cli.mjs";
  await import(guard);
  const [{ default: http }, { default: https }, { default: net }, { default: tls },
    { default: http2 }, { default: dgram }, { default: fs }, { default: fsp }, { syncBuiltinESMExports }] =
    await Promise.all([import("node:http"), import("node:https"), import("node:net"), import("node:tls"),
      import("node:http2"), import("node:dgram"), import("node:fs"), import("node:fs/promises"), import("node:module")]);
  const restores: (() => void)[] = [], forbidden: string[] = [];
  function block(owner: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    Object.defineProperty(owner, key, { ...descriptor, value: () => {
      forbidden.push(key); throw new Error(`Provider-free recovery test forbids ${key}`);
    } });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  for (const owner of [http, https]) for (const key of ["request", "get"]) block(owner, key);
  for (const key of ["connect", "createConnection"]) block(net, key);
  block(net.Socket.prototype, "connect"); block(tls, "connect"); block(http2, "connect");
  block(dgram, "createSocket"); block(globalThis, "fetch");
  const environment = process.env;
  process.env = new Proxy(environment, { get(target, key) {
    if (typeof key === "string" && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)) {
      forbidden.push("credential environment"); throw new Error("Credential environment access forbidden");
    }
    return Reflect.get(target, key);
  } });
  restores.push(() => { process.env = environment; });
  for (const owner of [fs, fsp]) for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor?.value === undefined) continue;
    Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
      apply(target, receiver, args) {
        if (/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(String(args[0]))) {
          forbidden.push("credential file"); throw new Error("Credential file access forbidden");
        }
        return Reflect.apply(target, receiver, args);
      }
    }) });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  syncBuiltinESMExports();
  return { forbidden, restore: () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
});

import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, UNKNOWN_UTTERANCE_ATTRIBUTION,
  SourceSemanticInterpretationSchema, sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { authoredQuerySemantics } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { buildRecoveryCorrespondenceWorkset } from "../../../runs/semantic-chain/recovery-correspondence.js";
import { bindRecoveryReasonCorrespondence, buildRecoveryReasonCorrespondenceItems } from
  "../../../runs/semantic-chain/recovery-reason.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";

afterAll(() => { isolation.restore(); expect(isolation.forbidden).toEqual([]); });

const ORIGINAL = "which parcel was sent and inspected?";
const GENERATION = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1", provider_url: "http://127.0.0.1:9" };
const OPTIONS = { correspondence_demand: { kind: "query_branches" as const, maximum_demands_per_interpretation: 2 }, correspondence_cap: 2 };
const TOKENS = 4096;

function fixture(version = "1") {
  const query = authoredQuerySemantics({ original_query: ORIGINAL, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
    variables: [{ id: "parcel", sort: "entity" }, { id: "pSend", sort: "proposition" }, { id: "pInspect", sort: "proposition" }],
    alternatives: [{ frames: ["Send", "Inspect"].map(name => ({ id: `q${name}`, variable: `p${name}`,
      predicate_reading: name.toLowerCase(), role_requirements: [{ id: "object", role_reading: "object", target_variable: "parcel",
        support: { kind: "query_text", excerpt: "parcel" } }] })),
      context_obligations: ["qSend", "qInspect"].map(frame => ({ frame, kind: "asserted_at_source" })),
      answer_frames: [], evidence_inputs: [{ frames: ["qSend"] }, { frames: ["qInspect"] }] }],
    return_variables: ["parcel"], gaps: [],
    requested_operation: { reading: "identify parcel", support: { kind: "query_text", excerpt: "which parcel" } }
  }).query;
  const interpretation = SourceSemanticInterpretationSchema.parse({ contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: version, content_digest: `sha256:${fieldContractSha256(ORIGINAL)}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }, producer_id: "source-producer", producer_version: "1",
    contract_version: "source-interpretation-v4",
    mentions: [{ id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" }, text: "sent", utf8_span: [0, 4] }],
    referents: [], frames: [{ id: "fSend", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [], predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent"] },
      slots: [], bindings: [] }], operators: [], gaps: [], entry_roots: ["fSend"], asserted_at_scope: ["fSend"] });
  const descriptor = { source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256), interpretation };
  return { query: { original_query: ORIGINAL, query_semantics: query },
    selected: [{ source_id: "src", source_version: version, record_id: "record", descriptor }] };
}

function rows(workset: NonNullable<ReturnType<typeof buildRecoveryCorrespondenceWorkset>>) {
  return materializeSemanticProposalLines(workset, TOKENS).map(line => ({ line }));
}

it("preserves omitted full-catalog bytes and binds one C per H without a v7 contract check", () => {
  const { query, selected } = fixture();
  const items = buildRecoveryReasonCorrespondenceItems(query, selected);
  expect(items).toHaveLength(1);
  expect("generation_policy" in items[0]!).toBe(false);
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION)!;
  expect(workset.items).toEqual(items);
  const bound = bindRecoveryReasonCorrespondence(rows(workset), selected, query);
  expect(bound).toHaveLength(1);
  expect(bound[0]!.descriptor.source_interpretation_id).toBe(selected[0]!.descriptor.source_interpretation_id);
  expect((bound[0]!.row.line.request as SourceSemanticCorrespondenceRequest).contract)
    .toBe("source-semantic-correspondence-request-v7");
  expect("generation_policy" in bound[0]!.row.line.request).toBe(false);
});

it("binds two scoped C for one H by policy cache material, not workset index", () => {
  const { query, selected } = fixture();
  const second = fixture("2").selected;
  const both = [...selected, ...second];
  const options = { ...OPTIONS, correspondence_cap: 3 };
  const items = buildRecoveryReasonCorrespondenceItems(query, both, options);
  expect(items.map(item => item.source_interpretation_descriptors[0]!.source_interpretation_id))
    .toEqual([selected[0]!.descriptor.source_interpretation_id, selected[0]!.descriptor.source_interpretation_id,
      second[0]!.descriptor.source_interpretation_id]);
  expect(items.every(item => "generation_policy" in item)).toBe(true);
  const workset = buildRecoveryCorrespondenceWorkset(query, both, GENERATION, options)!;
  expect(workset.items).toEqual(items);
  const bound = bindRecoveryReasonCorrespondence(rows(workset), both, query, options);
  expect(bound.map(row => row.descriptor.source_interpretation_id))
    .toEqual(items.map(item => item.source_interpretation_descriptors[0]!.source_interpretation_id));
  expect(new Set(bound.map(row => (row.row.line.request as SourceSemanticCorrespondenceRequest).contract)))
    .toEqual(new Set(["source-semantic-correspondence-request-v8"]));
  expect(() => bindRecoveryReasonCorrespondence(rows(workset).slice(0, 1), both, query, options))
    .toThrow(/denominator changed/u);
});

it("fails closed on unpaired preparation options, duplicate C material, or a foreign H", () => {
  const { query, selected } = fixture();
  expect(() => buildRecoveryReasonCorrespondenceItems(query, selected, { correspondence_cap: 1 }))
    .toThrow(/must appear together/u);
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, OPTIONS)!;
  const duplicate = rows(workset);
  expect(() => bindRecoveryReasonCorrespondence([...duplicate, ...duplicate], selected, query, OPTIONS))
    .toThrow(/denominator changed|binds frozen Q and published H/u);
  expect(() => bindRecoveryReasonCorrespondence(rows(workset), fixture("2").selected, query, OPTIONS))
    .toThrow(/binds frozen Q and published H/u);
});
