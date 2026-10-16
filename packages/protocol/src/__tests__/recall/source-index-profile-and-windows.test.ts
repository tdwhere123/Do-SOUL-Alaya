import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceGoldRootIdentity } from "../../recall/conditional-field/product-identity.js";
import { sourceRecallTarget } from "../../recall/conditional-field/product-identity.js";
import { hashContentDigest } from "../../recall/field-contract/canonical-identity.js";
import {
  SOURCE_INDEX_MAX_WINDOWS,
  SourceIndexCapacityExceeded,
  SourceIndexConfigurationSchema,
  SourceIndexProfileSchema,
  SourceIndexTargetSchema,
  prepareSourceIndexDocument,
  prepareSourceIndexLexical,
  sourceIndexConfigurationId,
  sourceIndexGenerationId,
  sourceIndexProfileId,
  sourceIndexTarget,
  type SourceIndexConfiguration,
  type SourceIndexProfile,
  type SourceIndexSelection,
  type SourceIndexTarget
} from "../../recall/source-index.js";
import { canonicalJson } from "../../recall/selection/capture/canonical-json.js";

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

const NFC_E = "\u00e9";
const NFD_E = "e\u0301";
const MIXED_BODY = `a😀中${NFC_E}${NFD_E}b`;
const ARTIFACT_A = `sha256:${"ab".repeat(32)}`;
const ARTIFACT_B = `sha256:${"cd".repeat(32)}`;

const PROFILE_IDENTITY_FIELDS = [
  "provider_kind", "model_id", "model_revision", "artifact_digest", "tokenizer_revision",
  "dimensions", "preprocessing", "normalization", "max_input_tokens", "windowing", "window_bytes"
] as const;

const PROFILE = SourceIndexProfileSchema.parse({
  provider_kind: "local",
  model_id: "embed-test",
  model_revision: "r1",
  artifact_digest: ARTIFACT_A,
  tokenizer_revision: "tok-1",
  dimensions: 8,
  preprocessing: "none",
  normalization: "nfc",
  max_input_tokens: 512,
  windowing: "utf8-byte-windows.v1",
  window_bytes: 4
});

const PROFILE_FIELD_CHANGES = {
  provider_kind: "remote",
  model_id: "embed-other",
  model_revision: "r2",
  artifact_digest: ARTIFACT_B,
  tokenizer_revision: "tok-2",
  dimensions: 16,
  preprocessing: "strip",
  normalization: "nfd",
  max_input_tokens: 1024,
  window_bytes: 8
} as const satisfies Partial<SourceIndexProfile>;

const CONFIG = SourceIndexConfigurationSchema.parse({ revision: "cfg-1", profile: PROFILE });

function digest(material: unknown): string {
  return `sha256:${sha256(canonicalJson(material))}`;
}

function evidenceTarget(body: string, workspaceId = "workspace-a", rootId = "record-1") {
  return sourceRecallTarget({
    workspace_id: workspaceId,
    root_kind: "source_record",
    root_id: rootId,
    source_version: "v1",
    content_digest: hashContentDigest(body, sha256),
    evidence_object_id: null
  });
}

function indexedSource(body: string, options: {
  workspaceId?: string; rootId?: string; sourceId?: string; bodyBytes?: number;
} = {}): SourceIndexTarget {
  return sourceIndexTarget(
    evidenceTarget(body, options.workspaceId, options.rootId),
    options.sourceId ?? "logical-source",
    options.bodyBytes ?? utf8(body).length
  );
}

/** Pack complete UTF-8 code points into window_bytes without copying the production walk-back. */
function expectedWindows(body: string, windowBytes: number): readonly { start: number; end: number; text: string }[] {
  const windows: { start: number; end: number; text: string }[] = [];
  let start = 0;
  let packed = "";
  let used = 0;
  for (const char of body) {
    const size = utf8(char).length;
    if (used > 0 && used + size > windowBytes) {
      windows.push({ start, end: start + used, text: packed });
      start += used;
      packed = "";
      used = 0;
    }
    packed += char;
    used += size;
  }
  if (used > 0) windows.push({ start, end: start + used, text: packed });
  return windows;
}

function validation(pattern: RegExp) {
  return expect.objectContaining({
    name: "AlayaError",
    code: "VALIDATION",
    message: expect.stringMatching(pattern)
  });
}

describe("source index profile and configuration identity", () => {
  it("hashes every declared profile and configuration field and ignores property order", () => {
    const parsedProfile = SourceIndexProfileSchema.parse(PROFILE);
    expect(Object.keys(parsedProfile).sort()).toEqual([...PROFILE_IDENTITY_FIELDS].sort());
    expect(Object.keys(SourceIndexConfigurationSchema.parse(CONFIG)).sort()).toEqual(["profile", "revision"]);
    const profileId = sourceIndexProfileId(PROFILE, sha256);
    expect(profileId).toBe(digest(["source-index-profile.v1", parsedProfile]));
    expect(canonicalJson(parsedProfile)).toContain("\"windowing\":\"utf8-byte-windows.v1\"");
    for (const field of PROFILE_IDENTITY_FIELDS) {
      if (field === "windowing") {
        expect(() => sourceIndexProfileId({ ...PROFILE, windowing: "other" as SourceIndexProfile["windowing"] }, sha256))
          .toThrow();
        continue;
      }
      expect(sourceIndexProfileId({ ...PROFILE, [field]: PROFILE_FIELD_CHANGES[field] }, sha256), field)
        .not.toBe(profileId);
    }
    const reversedProfile: SourceIndexProfile = {
      window_bytes: PROFILE.window_bytes,
      windowing: PROFILE.windowing,
      max_input_tokens: PROFILE.max_input_tokens,
      normalization: PROFILE.normalization,
      preprocessing: PROFILE.preprocessing,
      dimensions: PROFILE.dimensions,
      tokenizer_revision: PROFILE.tokenizer_revision,
      artifact_digest: PROFILE.artifact_digest,
      model_revision: PROFILE.model_revision,
      model_id: PROFILE.model_id,
      provider_kind: PROFILE.provider_kind
    };
    expect(sourceIndexProfileId(reversedProfile, sha256)).toBe(profileId);

    const configId = sourceIndexConfigurationId(CONFIG, sha256);
    expect(configId).toBe(digest(["source-index-configuration.v1", SourceIndexConfigurationSchema.parse(CONFIG)]));
    expect(sourceIndexConfigurationId({ revision: "cfg-2", profile: PROFILE }, sha256)).not.toBe(configId);
    expect(sourceIndexConfigurationId({ revision: CONFIG.revision, profile: { ...PROFILE, model_id: "embed-other" } }, sha256))
      .not.toBe(configId);
    const reversedConfig: SourceIndexConfiguration = { profile: reversedProfile, revision: CONFIG.revision };
    expect(sourceIndexConfigurationId(reversedConfig, sha256)).toBe(configId);

    const capturedProfile = { ...PROFILE };
    const beforeProfile = { ...capturedProfile };
    expect(sourceIndexProfileId(capturedProfile, sha256)).toBe(profileId);
    capturedProfile.model_id = "mutated-after-capture";
    expect(capturedProfile).not.toEqual(beforeProfile);
    expect(sourceIndexProfileId(beforeProfile, sha256)).toBe(profileId);
  });

  it("binds generation identity to captured workspace, revision, config, and epoch only", () => {
    const selection: SourceIndexSelection = {
      workspace_id: "workspace-a",
      selection_revision: 3,
      config_id: sourceIndexConfigurationId(CONFIG, sha256),
      profile_id: sourceIndexProfileId(PROFILE, sha256),
      configuration: CONFIG
    };
    const generationId = sourceIndexGenerationId(selection, 9, sha256);
    expect(generationId).toBe(digest([
      "source-index-generation.v1", selection.workspace_id, selection.selection_revision, selection.config_id, 9
    ]));
    const reordered: SourceIndexSelection = {
      configuration: CONFIG,
      profile_id: selection.profile_id,
      config_id: selection.config_id,
      selection_revision: selection.selection_revision,
      workspace_id: selection.workspace_id
    };
    expect(sourceIndexGenerationId(reordered, 9, sha256)).toBe(generationId);
    expect(sourceIndexGenerationId({ ...selection, workspace_id: "workspace-b" }, 9, sha256)).not.toBe(generationId);
    expect(sourceIndexGenerationId({ ...selection, selection_revision: 4 }, 9, sha256)).not.toBe(generationId);
    expect(sourceIndexGenerationId({ ...selection, config_id: ARTIFACT_B }, 9, sha256)).not.toBe(generationId);
    expect(sourceIndexGenerationId(selection, 10, sha256)).not.toBe(generationId);
    expect(sourceIndexGenerationId({ ...selection, profile_id: ARTIFACT_B }, 9, sha256)).toBe(generationId);
    const mutated = { ...selection, workspace_id: "workspace-a" };
    const captured = sourceIndexGenerationId(mutated, 9, sha256);
    mutated.workspace_id = "workspace-b";
    expect(captured).toBe(generationId);
  });
});

describe("source index windows", () => {
  it("places independently calculated UTF-8 intervals for emoji, CJK, and partial window cuts", () => {
    expect(utf8("a").length).toBe(1);
    expect(utf8("😀").length).toBe(4);
    expect(utf8("中").length).toBe(3);
    expect(utf8(NFC_E).length).toBe(2);
    expect(utf8(NFD_E).length).toBe(3);
    expect(utf8(NFC_E).equals(utf8(NFD_E))).toBe(false);
    expect(NFC_E).not.toBe(NFD_E);
    const codePoints = ["a", "😀", "中", NFC_E, "e", "\u0301", "b"] as const;
    let offset = 0;
    const intervals = codePoints.map((part) => {
      const start = offset;
      offset += utf8(part).length;
      return { part, start, end: offset, bytes: offset - start };
    });
    expect(intervals.map((row) => [row.start, row.end, row.bytes])).toEqual([
      [0, 1, 1], [1, 5, 4], [5, 8, 3], [8, 10, 2], [10, 11, 1], [11, 13, 2], [13, 14, 1]
    ]);
    expect(offset).toBe(utf8(MIXED_BODY).length);
    expect(codePoints.join("")).toBe(MIXED_BODY);

    const input = { source: indexedSource(MIXED_BODY), body: MIXED_BODY, profile: PROFILE };
    const before = structuredClone(input);
    const document = prepareSourceIndexDocument(input, sha256);
    expect(input).toEqual(before);
    input.body = "mutated";
    input.profile = { ...PROFILE, window_bytes: 32 };
    expect(document.body).toBe(MIXED_BODY);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.windows)).toBe(true);

    // Pack complete code points, not grapheme clusters: NFC é and NFD e+́ stay distinct bytes.
    const expected = expectedWindows(MIXED_BODY, PROFILE.window_bytes);
    expect(expected.map((window) => [window.start, window.end, window.text])).toEqual([
      [0, 1, "a"],
      [1, 5, "😀"],
      [5, 8, "中"],
      [8, 11, `${NFC_E}e`],
      [11, 14, "\u0301b"]
    ]);
    assertExactWindows(document, MIXED_BODY, PROFILE, expected);
  });

  it("never splits a multibyte code point at minimum window_bytes 4", () => {
    for (const body of ["😀😄", "中中中", `x😀${NFC_E}`, "你好"] as const) {
      const document = prepareSourceIndexDocument({
        source: indexedSource(body), body, profile: PROFILE
      }, sha256);
      const expected = expectedWindows(body, 4);
      expect(expected.length).toBeGreaterThan(0);
      assertExactWindows(document, body, PROFILE, expected);
      for (const window of document.windows) {
        let accounted = 0;
        for (const char of window.text) accounted += utf8(char).length;
        expect(accounted).toBe(window.end_byte - window.start_byte);
        expect(utf8(window.text).equals(utf8(body).subarray(window.start_byte, window.end_byte))).toBe(true);
      }
    }
  });

  it("keeps NFC and NFD source bodies as distinct window text", () => {
    const nfc = indexedSource(NFC_E);
    const nfd = indexedSource(NFD_E);
    const nfcDoc = prepareSourceIndexDocument({ source: nfc, body: NFC_E, profile: PROFILE }, sha256);
    const nfdDoc = prepareSourceIndexDocument({ source: nfd, body: NFD_E, profile: PROFILE }, sha256);
    expect(nfcDoc.windows.map((window) => window.text)).toEqual([NFC_E]);
    expect(nfdDoc.windows.map((window) => window.text)).toEqual([NFD_E]);
    expect(nfcDoc.windows[0]!.content_digest).not.toBe(nfdDoc.windows[0]!.content_digest);
    expect(nfcDoc.windows[0]!.end_byte).toBe(2);
    expect(nfdDoc.windows[0]!.end_byte).toBe(3);
  });

  it("returns an explicitly empty window list for a zero-byte source", () => {
    const lexical = prepareSourceIndexLexical({ source: indexedSource(""), body: "" }, sha256);
    expect(lexical.body).toBe("");
    expect(lexical.bytes.length).toBe(0);
    const document = prepareSourceIndexDocument({
      source: indexedSource(""), body: "", profile: PROFILE
    }, sha256);
    expect(document.body).toBe("");
    expect(document.windows).toEqual([]);
    expect(document.windows).toHaveLength(0);
  });

  it("throws when prepared windows would exceed capacity instead of returning a clipped list", () => {
    const exactBody = "n".repeat(SOURCE_INDEX_MAX_WINDOWS * PROFILE.window_bytes);
    const exact = prepareSourceIndexDocument({
      source: indexedSource(exactBody), body: exactBody, profile: PROFILE
    }, sha256);
    expect(exact.windows).toHaveLength(SOURCE_INDEX_MAX_WINDOWS);
    expect(exact.windows.at(-1)!.end_byte).toBe(utf8(exactBody).length);
    expect(exact.windows.map((window) => window.text).join("")).toBe(exactBody);

    const overflowBody = `${exactBody}x`;
    expect(() => prepareSourceIndexDocument({
      source: indexedSource(overflowBody), body: overflowBody, profile: PROFILE
    }, sha256)).toThrow(SourceIndexCapacityExceeded);
    expect(() => prepareSourceIndexDocument({
      source: indexedSource(overflowBody), body: overflowBody, profile: PROFILE
    }, sha256)).toThrowError(validation(/capacity/u));
  });
});

describe("source index preparation refusals and source identity", () => {
  it("keeps source logical id distinct from persisted record id and separates workspaces", () => {
    const body = "hello";
    const first = indexedSource(body, { sourceId: "logical-source", rootId: "record-1" });
    const second = indexedSource(body, { sourceId: "other-logical", rootId: "record-1" });
    expect(first.source_id).toBe("logical-source");
    expect(first.target.root_id).toBe("record-1");
    expect(first.source_id).not.toBe(first.target.root_id);
    expect(first.root_key).toBe(sourceGoldRootIdentity(first.target));
    expect(first.root_key).toBe(second.root_key);
    expect(first.source_id).not.toBe(second.source_id);

    const otherWorkspace = indexedSource(body, { workspaceId: "workspace-b", sourceId: "logical-source", rootId: "record-1" });
    expect(otherWorkspace.source_id).toBe(first.source_id);
    expect(otherWorkspace.target.root_id).toBe(first.target.root_id);
    expect(otherWorkspace.root_key).not.toBe(first.root_key);
    expect(otherWorkspace.target.workspace_id).toBe("workspace-b");
  });

  it("rejects spanned and non-record targets at the source target constructor", () => {
    const digestValue = hashContentDigest("hello", sha256);
    expect(() => sourceIndexTarget(sourceRecallTarget({
      workspace_id: "workspace-a",
      root_kind: "source_record",
      root_id: "record-1",
      source_version: "v1",
      content_digest: digestValue,
      evidence_object_id: null,
      span: {
        content_start: 0, content_end: 5, retained_extent: "excerpt",
        content_complete: false, original_complete: false
      }
    }), "logical-source", 5)).toThrow();
    expect(() => sourceIndexTarget(sourceRecallTarget({
      workspace_id: "workspace-a",
      root_kind: "evidence_capsule",
      root_id: "record-1",
      source_version: "v1",
      content_digest: digestValue,
      evidence_object_id: null
    }), "logical-source", 5)).toThrow();
  });

  it("rejects mismatched byte count, digest, root identity, and unpaired surrogates", () => {
    const body = MIXED_BODY;
    const source = indexedSource(body);
    expect(() => prepareSourceIndexLexical({
      source: indexedSource(body, { bodyBytes: utf8(body).length + 1 }), body
    }, sha256)).toThrowError(validation(/complete exact source bytes/u));
    expect(() => prepareSourceIndexLexical({
      source: sourceIndexTarget(sourceRecallTarget({
        workspace_id: "workspace-a",
        root_kind: "source_record",
        root_id: "record-1",
        source_version: "v1",
        content_digest: hashContentDigest("other", sha256),
        evidence_object_id: null
      }), "logical-source", utf8(body).length),
      body
    }, sha256)).toThrowError(validation(/complete exact source bytes/u));
    expect(() => prepareSourceIndexLexical({
      source: SourceIndexTargetSchema.parse({ ...source, root_key: sourceGoldRootIdentity(evidenceTarget(body, "workspace-b")) }),
      body
    }, sha256)).toThrowError(validation(/complete exact source bytes/u));

    for (const unpaired of ["\uD800", "\uDFFF", "ok\uDEAD"] as const) {
      expect(() => prepareSourceIndexLexical({
        source: indexedSource(unpaired), body: unpaired
      }, sha256)).toThrowError(validation(/complete exact source bytes/u));
    }
    expect(prepareSourceIndexLexical({ source: indexedSource("😀"), body: "😀" }, sha256).body).toBe("😀");
  });
});

function assertExactWindows(
  document: ReturnType<typeof prepareSourceIndexDocument>,
  body: string,
  profile: SourceIndexProfile,
  expected: readonly { start: number; end: number; text: string }[]
): void {
  const bytes = utf8(body);
  const profileId = sourceIndexProfileId(profile, sha256);
  expect(document.profile_id).toBe(profileId);
  expect(document.body).toBe(body);
  expect(document.windows).toHaveLength(expected.length);
  expect(document.windows.map((window) => window.text).join("")).toBe(body);
  if (expected.length > 0) {
    expect(document.windows[0]!.start_byte).toBe(0);
    expect(document.windows.at(-1)!.end_byte).toBe(bytes.length);
  }
  for (const [index, window] of document.windows.entries()) {
    const want = expected[index]!;
    expect(window.ordinal).toBe(index);
    expect(window.start_byte).toBe(want.start);
    expect(window.end_byte).toBe(want.end);
    expect(window.text).toBe(want.text);
    expect(window.end_byte).toBeGreaterThan(window.start_byte);
    if (index > 0) expect(window.start_byte).toBe(document.windows[index - 1]!.end_byte);
    const slice = bytes.subarray(window.start_byte, window.end_byte);
    expect(slice.length).toBe(window.end_byte - window.start_byte);
    expect(utf8(window.text).equals(slice)).toBe(true);
    expect(window.text).toBe(slice.toString("utf8"));
    expect(window.content_digest).toBe(hashContentDigest(window.text, sha256));
    expect(window.window_id).toBe(digest([
      "source-index-window.v1", document.source.root_key, profileId,
      window.start_byte, window.end_byte, window.content_digest
    ]));
  }
}
