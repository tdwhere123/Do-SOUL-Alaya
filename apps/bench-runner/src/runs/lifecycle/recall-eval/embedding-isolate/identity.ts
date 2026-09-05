export interface EmbeddingIsolateIdentity {
  readonly providerKind: string;
  readonly modelId: string;
  readonly vectorSpace: string;
  readonly schemaVersion: number;
  readonly artifactId: string;
}

export type EmbeddingIsolateIdentityProof =
  | { readonly status: "match"; readonly identity: FrozenEmbeddingIsolateIdentity }
  | { readonly status: "mismatch"; readonly reason: string }
  | { readonly status: "uncertain"; readonly reason: string };

export type FrozenEmbeddingIsolateIdentity = Readonly<EmbeddingIsolateIdentity>;

const IDENTITY_KEYS = [
  "providerKind",
  "modelId",
  "vectorSpace",
  "schemaVersion",
  "artifactId"
] as const;

const UNCERTAIN_TOKEN = /^(unknown|uncertain|unspecified|not_observed|n\/a)$/iu;

export class EmbeddingIsolateIdentityError extends Error {
  public readonly kind: "mismatch" | "uncertain";

  public constructor(kind: "mismatch" | "uncertain", message: string) {
    super(message);
    this.name = "EmbeddingIsolateIdentityError";
    this.kind = kind;
  }
}

export function freezeEmbeddingIsolateIdentity(
  input: EmbeddingIsolateIdentity
): FrozenEmbeddingIsolateIdentity {
  const identity = Object.freeze({
    providerKind: requireToken(input.providerKind, "providerKind"),
    modelId: requireToken(input.modelId, "modelId"),
    vectorSpace: requireToken(input.vectorSpace, "vectorSpace"),
    schemaVersion: requireSchemaVersion(input.schemaVersion),
    artifactId: requireToken(input.artifactId, "artifactId")
  });
  const uncertain = uncertainReason(identity);
  if (uncertain !== null) {
    throw new EmbeddingIsolateIdentityError("uncertain", uncertain);
  }
  return identity;
}

export function identitiesEqual(
  left: FrozenEmbeddingIsolateIdentity,
  right: FrozenEmbeddingIsolateIdentity
): boolean {
  return left.providerKind === right.providerKind &&
    left.modelId === right.modelId &&
    left.vectorSpace === right.vectorSpace &&
    left.schemaVersion === right.schemaVersion &&
    left.artifactId === right.artifactId;
}

export function proveLeaseIdentity(
  claimed: EmbeddingIsolateIdentity,
  owner: FrozenEmbeddingIsolateIdentity
): FrozenEmbeddingIsolateIdentity {
  const proof = inspectLeaseIdentity(claimed, owner);
  if (proof.status === "match") return proof.identity;
  throw new EmbeddingIsolateIdentityError(proof.status, proof.reason);
}

export function inspectLeaseIdentity(
  claimed: EmbeddingIsolateIdentity,
  owner: FrozenEmbeddingIsolateIdentity
): EmbeddingIsolateIdentityProof {
  let frozen: FrozenEmbeddingIsolateIdentity;
  try {
    frozen = freezeEmbeddingIsolateIdentity(claimed);
  } catch (error) {
    if (error instanceof EmbeddingIsolateIdentityError && error.kind === "uncertain") {
      return { status: "uncertain", reason: error.message };
    }
    throw error;
  }
  if (!identitiesEqual(frozen, owner)) {
    return {
      status: "mismatch",
      reason: "claimed embedding isolate identity does not match the session owner"
    };
  }
  return { status: "match", identity: frozen };
}

function requireToken(value: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EmbeddingIsolateIdentityError(
      "uncertain",
      `embedding isolate ${path} is empty or not a string`
    );
  }
  return value;
}

function requireSchemaVersion(value: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EmbeddingIsolateIdentityError(
      "uncertain",
      "embedding isolate schemaVersion is not a proven positive integer"
    );
  }
  return value;
}

function uncertainReason(identity: FrozenEmbeddingIsolateIdentity): string | null {
  const blob = IDENTITY_KEYS.map((key) => String(identity[key])).join("\0");
  if (blob.includes("execution_arch") || /reference\s*\|\s*optimized/u.test(blob)) {
    return "embedding isolate identity must not encode execution_arch or reference|optimized";
  }
  for (const key of IDENTITY_KEYS) {
    const value = identity[key];
    if (typeof value === "string" && UNCERTAIN_TOKEN.test(value.trim())) {
      return `embedding isolate ${key} is uncertain`;
    }
  }
  return null;
}
