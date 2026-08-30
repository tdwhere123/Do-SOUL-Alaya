import {
  freezeShadow,
  requireNonemptyString,
  ShadowContractError
} from "../envelope.js";
import type { SupportNodeKind } from "./types.js";

const CANDIDATE_KEY = /^(workspace_local|global):[A-Za-z0-9_]+:.+$/u;
const CONTENT_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const HASHED_SUPPORT = /^verified_user_assertion:/u;

const SEMANTIC_KINDS: ReadonlySet<SupportNodeKind> = new Set([
  "answer_binding",
  "proposition"
]);

export function parseSupportNodeId(kind: SupportNodeKind, id: unknown): string {
  const value = requireNonemptyString(id, `${kind} id`);
  if (kind === "candidate_projection") return value;
  if (kind === "source_lineage") return parseLineageId(value);
  if (kind === "evidence_unit") return parseEvidenceUnitId(value);
  if (SEMANTIC_KINDS.has(kind)) return parseSemanticId(kind, value);
  throw new ShadowContractError(`unknown support node kind: ${kind}`);
}

export function parseQueryPin(value: unknown, label: string): string {
  return requireNonemptyString(value, label);
}

export function nodeKey(kind: SupportNodeKind, id: string): string {
  return `${kind}\0${id}`;
}

export function freezeEndpoint(
  kind: SupportNodeKind,
  id: string
): Readonly<{ readonly kind: SupportNodeKind; readonly id: string }> {
  return freezeShadow({ kind, id: parseSupportNodeId(kind, id) });
}

function parseSemanticId(kind: SupportNodeKind, value: string): string {
  if (CANDIDATE_KEY.test(value)) {
    throw new ShadowContractError(`${kind} cannot use a candidate_key as semantic identity`);
  }
  if (CONTENT_DIGEST.test(value) || HASHED_SUPPORT.test(value)) {
    throw new ShadowContractError(`${kind} cannot use a content hash as semantic identity`);
  }
  if (value.startsWith("object:") || value.startsWith("evidence:")) {
    throw new ShadowContractError(`${kind} cannot use an object or evidence key as semantic identity`);
  }
  return value;
}

function parseEvidenceUnitId(value: string): string {
  if (CANDIDATE_KEY.test(value)) {
    throw new ShadowContractError("evidence_unit cannot use a candidate_key as unit identity");
  }
  if (CONTENT_DIGEST.test(value) || HASHED_SUPPORT.test(value)) {
    throw new ShadowContractError("content hash cannot mint an evidence unit");
  }
  return value;
}

function parseLineageId(value: string): string {
  if (CANDIDATE_KEY.test(value)) {
    throw new ShadowContractError("source_lineage cannot use a candidate_key as lineage identity");
  }
  return value;
}
