import { createHash } from "node:crypto";
import { CoreError } from "../shared/errors.js";
import {
  SourceIndexProfileSchema, SourceIndexWindowingSchema, SourceEmbeddingRepresentationSchema, SourceEmbeddingRoleSchema,
  hashContentDigest, sourceIndexProfileId,
  type SourceIndexProfile, type SourceIndexWindowing, type SourceEmbeddingRepresentation, type SourceEmbeddingRole
} from "@do-soul/alaya-protocol";

/** Private runtime evidence; not a second Source profile or durable index authority. */
export interface SourceEmbeddingInput {
  readonly input_id: string; readonly text: string;
  /** Required by paired representations; omission retains legacy raw-input compatibility only. */
  readonly role?: SourceEmbeddingRole;
}
export interface SourceEmbeddingOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly profile_id: string;
}
export interface SourceEmbeddingBindingOptions {
  readonly window_bytes: number;
  /** Omission selects recorded-message windows; explicit raw windows remain supported. */
  readonly windowing?: SourceIndexWindowing;
  /** May lower, never raise, the loaded model/tokenizer limit. */
  readonly max_input_tokens?: number;
  readonly representation?: SourceEmbeddingRepresentation;
}
export type SourceEmbeddingResult = Readonly<{
  input_id: string; input_digest: string;
  /** Paired successes attest preparation as well as the unchanged original input. */
  role?: SourceEmbeddingRole; prepared_input_digest?: string;
}> & (Readonly<{
  status: "embedded"; vector: Float32Array; token_count: number; truncated: false;
}> | Readonly<{
  status: "not_embedded"; reason: string; token_count: number | null;
}>);
export interface SourceEmbeddingBinding {
  readonly status: "ready";
  readonly profile: SourceIndexProfile;
  readonly profile_id: string;
  embedInputs(inputs: readonly SourceEmbeddingInput[], options: SourceEmbeddingOptions): Promise<readonly SourceEmbeddingResult[]>;
}
export type SourceEmbeddingBindingResult = SourceEmbeddingBinding | Readonly<{
  status: "unsupported"; reason: string;
}>;

export const sourceEmbeddingSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const sourceEmbeddingInputDigest = (text: string): string => hashContentDigest(text, sourceEmbeddingSha256);
export const SOURCE_EMBEDDING_MAX_BATCH_INPUTS = 64;

/** Capture before the first await, including strings used by both inference and digesting. */
export function captureSourceEmbeddingInputs(inputs: readonly SourceEmbeddingInput[]): readonly SourceEmbeddingInput[] {
  if (!Array.isArray(inputs)) throw new CoreError("VALIDATION", "Source embedding inputs must be an array");
  if (inputs.length > SOURCE_EMBEDDING_MAX_BATCH_INPUTS) {
    throw new CoreError("VALIDATION", `Source embedding batch exceeds ${SOURCE_EMBEDDING_MAX_BATCH_INPUTS} inputs`);
  }
  let bytes = 0;
  const captured = Array.from(inputs, value => {
    const input = { ...value };
    if (typeof input.input_id !== "string" || input.input_id.length > 2048 || typeof input.text !== "string") {
      throw new CoreError("VALIDATION", "Invalid Source embedding input");
    }
    bytes += Buffer.byteLength(input.text, "utf8");
    if (input.role !== undefined && !SourceEmbeddingRoleSchema.safeParse(input.role).success) {
      throw new CoreError("VALIDATION", "Invalid Source embedding role");
    }
    return Object.freeze({ input_id: input.input_id, text: input.text,
      ...(input.role === undefined ? {} : { role: input.role }) });
  });
  if (bytes > 4 * 1024 * 1024) throw new CoreError("VALIDATION", "Source embedding batch exceeds 4 MiB");
  return Object.freeze(captured);
}

/** Admission before any load/wait; nested representation is copied and frozen by its authority. */
export function captureSourceEmbeddingBindingOptions(options: SourceEmbeddingBindingOptions):
  SourceEmbeddingBindingOptions & Readonly<{ windowing: SourceIndexWindowing }> {
  const captured = structuredClone(options);
  if (!captured || typeof captured !== "object" || Array.isArray(captured) ||
      Object.keys(captured).some(key => !["window_bytes", "windowing", "max_input_tokens", "representation"].includes(key)) ||
      !SourceIndexProfileSchema.unwrap().shape.window_bytes.safeParse(captured.window_bytes).success ||
      (captured.windowing !== undefined && !SourceIndexWindowingSchema.safeParse(captured.windowing).success) ||
      (captured.max_input_tokens !== undefined && (!Number.isSafeInteger(captured.max_input_tokens) || captured.max_input_tokens < 1))) {
    throw new CoreError("VALIDATION", "Invalid Source embedding binding options");
  }
  return Object.freeze({ ...captured, windowing: captured.windowing ?? "recorded-message-windows.v1",
    ...(captured.representation === undefined ? {} : {
    representation: SourceEmbeddingRepresentationSchema.parse(captured.representation)
  }) });
}

/** The only text-preparation policy. Source identities always continue to digest input.text. */
export function prepareSourceEmbeddingText(input: SourceEmbeddingInput, profile: SourceIndexProfile): string {
  if (profile.representation === undefined) return input.text;
  if (input.role !== "query" && input.role !== "passage") {
    throw new CoreError("VALIDATION", "source_embedding_role_required");
  }
  return (input.role === "query" ? profile.representation.query_prefix : profile.representation.passage_prefix) + input.text;
}

export function sourceEmbeddingRefusals(inputs: readonly SourceEmbeddingInput[], reason: string,
  observed?: readonly SourceEmbeddingResult[]): readonly SourceEmbeddingResult[] {
  return Object.freeze(inputs.map((input, index) => Object.freeze({ status: "not_embedded" as const,
    input_id: input.input_id, input_digest: sourceEmbeddingInputDigest(input.text), reason,
    token_count: observed?.[index]?.token_count ?? null })));
}

export function captureSourceEmbeddingProfile(profile: SourceIndexProfile, profileId?: string): SourceIndexProfile {
  const captured = SourceIndexProfileSchema.parse(structuredClone(profile));
  if (profileId !== undefined && sourceIndexProfileId(captured, sourceEmbeddingSha256) !== profileId) {
    throw new CoreError("VALIDATION", "Source embedding profile identity mismatch");
  }
  return captured;
}

/** Shared validation at the provider/IPC boundary. No opaque vector can become an attestation. */
export function validateSourceEmbeddingResults(inputs: readonly SourceEmbeddingInput[], results: readonly SourceEmbeddingResult[],
  profile: SourceIndexProfile): readonly SourceEmbeddingResult[] {
  if (!Array.isArray(results) || results.length !== inputs.length) throw new CoreError("OBLIGATION_VIOLATION", "Source embedding result count mismatch");
  return Object.freeze(Array.from(results, (result, index) => {
    const input = inputs[index]!;
    if (result.input_id !== input.input_id || result.input_digest !== sourceEmbeddingInputDigest(input.text)) {
      throw new CoreError("OBLIGATION_VIOLATION", "Source embedding input evidence mismatch");
    }
    if (result.status === "not_embedded") {
      if (typeof result.reason !== "string" || result.reason.length === 0 ||
          (result.token_count !== null && (!Number.isSafeInteger(result.token_count) || result.token_count < 0))) {
        throw new CoreError("OBLIGATION_VIOLATION", "Invalid Source embedding refusal");
      }
      return Object.freeze({ ...result });
    }
    if (profile.representation !== undefined && (result.role !== input.role ||
        result.prepared_input_digest !== sourceEmbeddingInputDigest(prepareSourceEmbeddingText(input, profile)))) {
      throw new CoreError("OBLIGATION_VIOLATION", "Source embedding preparation evidence mismatch");
    }
    if (result.status !== "embedded" || result.truncated !== false || !Number.isSafeInteger(result.token_count) ||
        result.token_count < 1 || result.token_count > profile.max_input_tokens ||
        !(result.vector instanceof Float32Array) || result.vector.length !== profile.dimensions ||
        !result.vector.every(Number.isFinite)) throw new CoreError("OBLIGATION_VIOLATION", "Invalid Source embedding attestation");
    return Object.freeze({ ...result, vector: new Float32Array(result.vector) });
  }));
}
