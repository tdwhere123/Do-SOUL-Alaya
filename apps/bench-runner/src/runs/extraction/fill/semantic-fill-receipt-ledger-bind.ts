import { readBoundedCanonicalUtf8Artifact, withRootBoundDirectory } from
  "../cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from "./manifest/durable-exclusive-publication.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import { readSemanticFillAttemptEvidence } from
  "./semantic-fill-attempt-ledger.js";
import type { SemanticFillAttempt } from "./semantic-fill-executor.js";

const PRIVATE_ROOT = ".semantic-fill-private";
const PUBLISHED_RECEIPTS = "published-receipts";
const MAX_REPLICA_BYTES = 16 * 1024 * 1024;

interface ReceiptLedgerMemberBindView {
  readonly runIdentity: string;
  readonly ledgerScopeIdentity: string;
  readonly attempts: readonly SemanticFillAttempt[];
}

export function publishLedgerBoundReceiptReplica(input: {
  readonly root: string;
  readonly lease: ExtractionCacheWriteLease;
  readonly runIdentity: string;
  readonly ledgerScopeIdentity: string;
  readonly attempts: readonly SemanticFillAttempt[];
}): void {
  input.lease.assertOwned();
  input.lease.assertRoot(input.root);
  const bytes = Buffer.from(`${JSON.stringify({
    runIdentity: input.runIdentity,
    ledgerScopeIdentity: input.ledgerScopeIdentity,
    attempts: input.attempts
  })}\n`, "utf8");
  if (bytes.byteLength > MAX_REPLICA_BYTES) {
    throw new Error("lazy semantic receipt ledger replica exceeds its bound");
  }
  withRootBoundDirectory({
    root: input.root, label: "ledger-published lazy receipt root"
  }, (stableRoot) => {
    withRootBoundDirectory({
      root: stableRoot,
      segments: [PRIVATE_ROOT, PUBLISHED_RECEIPTS],
      createSegments: true,
      label: "ledger-published lazy receipts"
    }, (directory) => {
      withRootBoundDirectory({
        root: stableRoot, segments: [".tmp"], createSegments: true,
        label: "ledger-published lazy receipt temporary root"
      }, (temporaryDirectory) => publishBytesExclusiveDurable({
        destination: `${directory}/${input.runIdentity}.json`,
        bytes,
        ownerIdentity: input.runIdentity,
        temporaryDirectory,
        allowExistingExact: true
      }));
    });
  });
}

export function assertReceiptLedgerMemberOutcomes(
  root: string,
  receipt: ReceiptLedgerMemberBindView
): void {
  const records = readSemanticFillAttemptEvidence(root)
    .filter((record) => record.scopeIdentity === receipt.ledgerScopeIdentity)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (records.length === 0 && receipt.attempts.some((attempt) =>
      attempt.outcome === "admitted" || attempt.outcome === "failed")) {
    throw new Error("lazy semantic receipt lacks durable ledger member evidence");
  }
  const receiptByMember = new Map<string, SemanticFillAttempt>();
  for (const attempt of receipt.attempts) {
    const identity = memberIdentity(attempt);
    if (receiptByMember.has(identity)) {
      throw new Error("lazy semantic receipt has duplicate member outcomes");
    }
    receiptByMember.set(identity, attempt);
  }
  const ledgerMembers = records.flatMap((record) => record.memberOutcomes);
  const projectsWarmOverAdmit = receipt.attempts.some((claimed) => {
    const durables = ledgerMembers.filter((member) =>
      memberIdentity(member) === memberIdentity(claimed));
    return claimed.outcome === "skipped" &&
      durables.some((durable) => durable.outcome === "admitted" && durable.reason === undefined);
  });
  if (projectsWarmOverAdmit) assertPublishedReceiptProjection(root, receipt);
  for (const claimed of receipt.attempts) {
    const durables = ledgerMembers.filter((member) =>
      memberIdentity(member) === memberIdentity(claimed));
    if (!claimedSupportedByLedger(claimed, durables)) {
      throw new Error("lazy semantic receipt member outcome differs from durable ledger evidence");
    }
  }
  for (const claimed of receipt.attempts) {
    if (claimed.outcome !== "admitted" && claimed.outcome !== "failed") continue;
    const durable = ledgerMembers.find((member) =>
      memberIdentity(member) === memberIdentity(claimed) &&
      memberBytes(member) === memberBytes(claimed));
    if (durable === undefined) {
      throw new Error("lazy semantic receipt durable outcome is not in ledger evidence");
    }
  }
}

function assertPublishedReceiptProjection(
  root: string,
  receipt: ReceiptLedgerMemberBindView
): void {
  let replica: {
    readonly runIdentity?: unknown;
    readonly ledgerScopeIdentity?: unknown;
    readonly attempts?: unknown;
  };
  try {
    replica = withRootBoundDirectory({
      root,
      segments: [PRIVATE_ROOT, PUBLISHED_RECEIPTS],
      label: "ledger-published lazy receipts"
    }, (directory) => JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: `${directory}/${receipt.runIdentity}.json`,
      maxBytes: MAX_REPLICA_BYTES,
      label: "ledger-published lazy receipt"
    })) as {
      readonly runIdentity?: unknown;
      readonly ledgerScopeIdentity?: unknown;
      readonly attempts?: unknown;
    });
  } catch {
    throw new Error("lazy semantic receipt member outcome differs from durable ledger evidence");
  }
  if (replica.runIdentity !== receipt.runIdentity ||
      replica.ledgerScopeIdentity !== receipt.ledgerScopeIdentity ||
      JSON.stringify(replica.attempts) !== JSON.stringify(receipt.attempts)) {
    throw new Error("lazy semantic receipt member outcome differs from durable ledger evidence");
  }
}

function memberIdentity(attempt: Pick<SemanticFillAttempt, "semanticKey" | "capability">): string {
  return `${attempt.semanticKey}\u0000${attempt.capability}`;
}

function memberBytes(attempt: SemanticFillAttempt): string {
  return JSON.stringify({
    semanticKey: attempt.semanticKey,
    capability: attempt.capability,
    outcome: attempt.outcome,
    ...(typeof attempt.reason === "string" ? { reason: attempt.reason } : {})
  });
}

function claimedSupportedByLedger(
  claimed: SemanticFillAttempt,
  durables: readonly SemanticFillAttempt[]
): boolean {
  if (claimed.outcome === "skipped") {
    return durables.length === 0 ||
      durables.some((durable) => durable.outcome === "admitted" && durable.reason === undefined);
  }
  if (claimed.outcome === "unresolved") {
    return !durables.some((durable) => durable.outcome === "admitted");
  }
  return durables.some((durable) => memberBytes(durable) === memberBytes(claimed));
}
