import { createHash } from "node:crypto";
import {
  computeOfficialApiSourceCorpusIdentity,
  parseOfficialApiSignals,
  resolveOfficialApiSourceLocatorQuote,
  type OfficialApiExtractionRequest,
  type OfficialApiSignalDraft
} from "@do-soul/alaya-soul";
import { rebindDraftToCurrentAssertionCatalog } from
  "./source-assertion-catalog-rebind.js";

export interface SourceDraftAnchorInput {
  readonly sourceDraftIndex: number;
  readonly sourceDraftSha256: string;
  readonly currentAssertionId: number;
}

export interface SourceDraftAnchorBinding {
  readonly source_draft_index: number;
  readonly source_draft_sha256: string;
  readonly current_anchor_assertion_id: number;
  readonly current_anchor_assertion_sha256: string;
  readonly proposed_quote_sha256: string;
  readonly grounded_source_assertion_sha256: string;
}

export function buildSourceDraftAnchorBindings(input: {
  readonly sourceRawJson: string;
  readonly sourceCorpus: string;
  readonly request: OfficialApiExtractionRequest;
  readonly assertionIds: readonly number[];
  readonly explicit?: readonly SourceDraftAnchorInput[];
}): readonly SourceDraftAnchorBinding[] {
  assertSourceCorpusIdentity(input.sourceCorpus, input.request);
  const drafts = parseOfficialApiSignals(input.sourceRawJson);
  const anchors = input.explicit === undefined
    ? locateCatalogAnchors(drafts, input.request, new Set(input.assertionIds))
    : validateExplicitAnchors(drafts, input.request, input.explicit);
  const bindings = anchors.map(({ sourceDraftIndex, currentAssertionId }) =>
    encodeBinding(drafts, sourceDraftIndex, input.sourceCorpus, input.request,
      currentAssertionId)
  );
  const boundIds = sortedUniqueNumbers(bindings.map(
    ({ current_anchor_assertion_id }) => current_anchor_assertion_id
  ));
  if (!sameNumbers(boundIds, input.assertionIds)) {
    throw new Error("source assertion supplement current request anchor mismatch");
  }
  return Object.freeze(bindings);
}

export function selectSourceDraftsByAnchorBindings(
  rawJson: string,
  bindings: readonly SourceDraftAnchorBinding[],
  request: OfficialApiExtractionRequest,
  sourceCorpus: string
): readonly OfficialApiSignalDraft[] {
  const drafts = parseOfficialApiSignals(rawJson);
  return Object.freeze(bindings.map((binding) => {
    const draft = drafts[binding.source_draft_index];
    if (draft === undefined || draftSha256(draft) !== binding.source_draft_sha256 ||
        sha256(draft.matched_text.trim()) !== binding.proposed_quote_sha256) {
      throw new Error("source assertion supplement source draft identity drifted");
    }
    assertAnchorBinding(binding, draft, request, sourceCorpus);
    return reanchorDraft(draft, binding.current_anchor_assertion_id);
  }));
}

export function assertGroundedPrimaryGap(input: {
  readonly bindings: readonly SourceDraftAnchorBinding[];
  readonly primaryRawJson: string;
  readonly sourceCorpus: string;
}): void {
  const covered = groundedAssertionSha256s(input.primaryRawJson, input.sourceCorpus);
  if (input.bindings.some(({ grounded_source_assertion_sha256 }) =>
    covered.has(grounded_source_assertion_sha256)
  )) {
    throw new Error("source assertion supplement target is no longer a primary-gap assertion");
  }
}

export function sourceObservationSha256s(
  bindings: readonly SourceDraftAnchorBinding[]
): readonly string[] {
  return Object.freeze([...new Set(bindings.map(
    ({ grounded_source_assertion_sha256 }) => grounded_source_assertion_sha256
  ))].sort(bytewiseCompare));
}

export function hasValidAnchorBindingShape(
  bindings: readonly SourceDraftAnchorBinding[],
  assertionIds: readonly number[],
  observationSha256s: readonly string[]
): boolean {
  const indices = bindings.map(({ source_draft_index }) => source_draft_index);
  return new Set(indices).size === indices.length &&
    sameNumbers(sortedUniqueNumbers(bindings.map(
      ({ current_anchor_assertion_id }) => current_anchor_assertion_id
    )), assertionIds) &&
    sameStrings(sourceObservationSha256s(bindings), observationSha256s);
}

function locateCatalogAnchors(
  drafts: readonly OfficialApiSignalDraft[],
  request: OfficialApiExtractionRequest,
  allowed: ReadonlySet<number>
): readonly SourceDraftAnchorInput[] {
  return Object.freeze(drafts.flatMap((draft, sourceDraftIndex) => {
    const rebound = rebindDraftToCurrentAssertionCatalog(draft, request, allowed);
    const currentAssertionId = rebound?.source_locator?.assertion_id;
    if (currentAssertionId === undefined || !allowed.has(currentAssertionId)) return [];
    return [{
      sourceDraftIndex,
      sourceDraftSha256: draftSha256(draft),
      currentAssertionId
    }];
  }));
}

function validateExplicitAnchors(
  drafts: readonly OfficialApiSignalDraft[],
  request: OfficialApiExtractionRequest,
  explicit: readonly SourceDraftAnchorInput[]
): readonly SourceDraftAnchorInput[] {
  const allowed = new Set(request.source_assertions.map(({ assertion_id }) => assertion_id));
  const indices = explicit.map(({ sourceDraftIndex }) => sourceDraftIndex);
  if (new Set(indices).size !== indices.length) {
    throw new Error("source assertion supplement has duplicate source draft identity");
  }
  for (const binding of explicit) {
    const draft = drafts[binding.sourceDraftIndex];
    if (!Number.isSafeInteger(binding.sourceDraftIndex) || binding.sourceDraftIndex < 0 ||
        draft === undefined || draftSha256(draft) !== binding.sourceDraftSha256) {
      throw new Error("source assertion supplement source draft identity is invalid");
    }
    if (!allowed.has(binding.currentAssertionId)) {
      throw new Error("source assertion supplement current request anchor is invalid");
    }
  }
  return Object.freeze([...explicit].sort((left, right) =>
    left.sourceDraftIndex - right.sourceDraftIndex
  ));
}

function encodeBinding(
  drafts: readonly OfficialApiSignalDraft[],
  sourceDraftIndex: number,
  sourceCorpus: string,
  request: OfficialApiExtractionRequest,
  currentAssertionId: number
): SourceDraftAnchorBinding {
  const draft = drafts[sourceDraftIndex];
  const anchor = request.source_assertions.find(
    ({ assertion_id }) => assertion_id === currentAssertionId
  );
  if (draft === undefined || anchor === undefined) {
    throw new Error("source assertion supplement current request anchor is invalid");
  }
  const resolution = resolveOfficialApiSourceLocatorQuote(
    sourceCorpus,
    { contract_version: 2, kind: "assertion_catalog", assertion_id: currentAssertionId },
    draft.matched_text
  );
  if (resolution.status === "rejected") {
    throw new Error(`source assertion supplement source quote is not grounded: ${resolution.reason}`);
  }
  return Object.freeze({
    source_draft_index: sourceDraftIndex,
    source_draft_sha256: draftSha256(draft),
    current_anchor_assertion_id: currentAssertionId,
    current_anchor_assertion_sha256: sha256(anchor.text),
    proposed_quote_sha256: sha256(draft.matched_text.trim()),
    grounded_source_assertion_sha256: sha256(resolution.assertion)
  });
}

function assertAnchorBinding(
  binding: SourceDraftAnchorBinding,
  draft: OfficialApiSignalDraft,
  request: OfficialApiExtractionRequest,
  sourceCorpus: string
): void {
  const anchor = request.source_assertions.find(
    ({ assertion_id }) => assertion_id === binding.current_anchor_assertion_id
  );
  if (anchor === undefined ||
      sha256(anchor.text) !== binding.current_anchor_assertion_sha256) {
    throw new Error("source assertion supplement anchor binding drifted");
  }
  const resolution = resolveOfficialApiSourceLocatorQuote(
    sourceCorpus,
    { contract_version: 2, kind: "assertion_catalog",
      assertion_id: binding.current_anchor_assertion_id },
    draft.matched_text
  );
  if (resolution.status === "rejected" ||
      sha256(resolution.assertion) !== binding.grounded_source_assertion_sha256) {
    throw new Error("source assertion supplement grounded source assertion drifted");
  }
}

function groundedAssertionSha256s(rawJson: string, sourceCorpus: string): ReadonlySet<string> {
  const output = new Set<string>();
  for (const draft of parseOfficialApiSignals(rawJson)) {
    const locator = draft.source_locator;
    if (locator === undefined) continue;
    const resolution = resolveOfficialApiSourceLocatorQuote(
      sourceCorpus,
      locator,
      draft.matched_text
    );
    if (resolution.status === "grounded") output.add(sha256(resolution.assertion));
  }
  return output;
}

function assertSourceCorpusIdentity(
  sourceCorpus: string,
  request: OfficialApiExtractionRequest
): void {
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    throw new Error("source assertion supplement source corpus identity drifted");
  }
}

function reanchorDraft(
  draft: OfficialApiSignalDraft,
  assertionId: number
): OfficialApiSignalDraft {
  return Object.freeze({
    ...draft,
    source_locator: Object.freeze({
      contract_version: 2 as const,
      kind: "assertion_catalog" as const,
      assertion_id: assertionId
    })
  });
}

function draftSha256(draft: OfficialApiSignalDraft): string {
  return sha256(JSON.stringify(draft));
}

function sortedUniqueNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
