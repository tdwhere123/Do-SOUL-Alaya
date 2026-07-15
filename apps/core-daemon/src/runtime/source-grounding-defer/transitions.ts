import {
  CoreError,
  fingerprintSourceGroundingClaimToken,
  type SourceGroundingDeferCommittedTransition,
  type SourceGroundingDeferTransitionPort
} from "@do-soul/alaya-core";
import { SignalState } from "@do-soul/alaya-protocol";
import type {
  SqliteEventLogRepo,
  SqliteSignalRepo,
  SqliteSourceGroundingDeferQueueRepo,
  StorageDatabase
} from "@do-soul/alaya-storage";

type TransitionRepos = Readonly<{
  eventLogRepo: SqliteEventLogRepo;
  signalRepo: SqliteSignalRepo;
  queueRepo: SqliteSourceGroundingDeferQueueRepo;
}>;

type ClaimCapability = NonNullable<
  ReturnType<SqliteSourceGroundingDeferQueueRepo["readClaimCapability"]>
>;

class ClaimMiss extends Error {}

export function createSourceGroundingDeferTransitions(
  repos: TransitionRepos
): SourceGroundingDeferTransitionPort {
  assertSharedStorageConnection(repos);
  return {
    recordDefer: (input) => repos.eventLogRepo.transactional(() => {
      assertClaimOwner(repos, input.signal.workspace_id, input.signal.signal_id, input.claim_token);
      const events = [
        repos.eventLogRepo.append(input.events[0]),
        repos.eventLogRepo.append(input.events[1])
      ] as const;
      const signal = requireSignalCas(repos, {
        signalId: input.signal.signal_id,
        workspaceId: input.signal.workspace_id,
        expectedState: input.claim_token === undefined ? SignalState.COMPILED : SignalState.DEFERRED,
        nextState: SignalState.DEFERRED
      });
      const queue_result = repos.queueRepo.enqueue({
        signal_id: signal.signal_id,
        workspace_id: signal.workspace_id,
        run_id: signal.run_id,
        defer_reason: input.defer_reason
      });
      return { signal, events, queue_result };
    }),
    claimRedrive: (input) => claimRedrive(repos, input),
    completeRedrive: (input) => repos.eventLogRepo.transactional(() => {
      assertClaimOwner(repos, input.workspace_id, input.signal_id, input.claim_token);
      const event = repos.eventLogRepo.append(input.event);
      const signal = requireSignalCas(repos, {
        signalId: input.signal_id,
        workspaceId: input.workspace_id,
        expectedState: SignalState.DEFERRED,
        nextState: SignalState.MATERIALIZED
      });
      if (!repos.queueRepo.removeClaimed(input.workspace_id, input.signal_id, input.claim_token)) {
        throw transitionConflict("Source-grounding redrive claim disappeared before completion.");
      }
      return { signal, event };
    }),
    failRedrive: (input) => failRedrive(repos, input),
    reconcileStaleClaim: (input) => reconcileStaleClaim(repos, input)
  };
}

function claimRedrive(
  repos: TransitionRepos,
  input: Parameters<SourceGroundingDeferTransitionPort["claimRedrive"]>[0]
) {
  try {
    return repos.eventLogRepo.transactional(() => {
      const audit_event = input.audit_event === undefined
        ? null
        : repos.eventLogRepo.append(input.audit_event);
      const queued = repos.queueRepo.claim(
        input.workspace_id,
        input.signal_id,
        input.claim_token,
        fingerprintSourceGroundingClaimToken(input.claim_token),
        input.claim_expires_at
      );
      if (queued === null) throw new ClaimMiss();
      const signal = repos.signalRepo.compareAndSwapState({
        signalId: input.signal_id,
        workspaceId: input.workspace_id,
        expectedState: SignalState.DEFERRED,
        nextState: SignalState.DEFERRED,
        ...(input.raw_payload === undefined ? {} : { rawPayload: input.raw_payload })
      });
      if (signal === null) throw new ClaimMiss();
      return { signal, audit_event, claim_token: input.claim_token };
    });
  } catch (error) {
    if (error instanceof ClaimMiss) return null;
    throw error;
  }
}

function failRedrive(
  repos: TransitionRepos,
  input: Parameters<SourceGroundingDeferTransitionPort["failRedrive"]>[0]
): SourceGroundingDeferCommittedTransition {
  return repos.eventLogRepo.transactional(() => {
    assertClaimOwner(repos, input.workspace_id, input.signal_id, input.claim_token);
    const event = repos.eventLogRepo.append(input.event);
    const signal = requireSignalCas(repos, {
      signalId: input.signal_id,
      workspaceId: input.workspace_id,
      expectedState: SignalState.DEFERRED,
      nextState: SignalState.DEFERRED
    });
    return { signal, event };
  });
}

function reconcileStaleClaim(
  repos: TransitionRepos,
  input: Parameters<SourceGroundingDeferTransitionPort["reconcileStaleClaim"]>[0]
): SourceGroundingDeferCommittedTransition {
  return repos.eventLogRepo.transactional(() => {
    const claim = readExpectedExpiredClaim(repos, input);
    const event = repos.eventLogRepo.append(input.event);
    const signal = requireSignalCas(repos, {
      signalId: input.signal_id,
      workspaceId: input.workspace_id,
      expectedState: SignalState.DEFERRED,
      nextState: SignalState.DEFERRED
    });
    if (!repos.queueRepo.clearExpiredClaim({
      workspaceId: input.workspace_id,
      signalId: input.signal_id,
      claimToken: claim.claimToken,
      claimExpiresAt: input.claim_expires_at,
      expiredBefore: input.expired_before
    })) {
      throw transitionConflict("Source-grounding redrive claim is active or no longer matches.");
    }
    return { signal, event };
  });
}

function readExpectedExpiredClaim(
  repos: TransitionRepos,
  input: Parameters<SourceGroundingDeferTransitionPort["reconcileStaleClaim"]>[0]
): ClaimCapability {
  const claim = repos.queueRepo.readClaimCapability(input.workspace_id, input.signal_id);
  if (
    claim === null || claim.claimExpiresAt !== input.claim_expires_at ||
    claim.claimExpiresAt > input.expired_before ||
    fingerprintSourceGroundingClaimToken(claim.claimToken) !== input.claim_token_fingerprint
  ) {
    throw transitionConflict("Source-grounding redrive claim is active or no longer matches.");
  }
  return claim;
}

function requireSignalCas(
  repos: TransitionRepos,
  input: Parameters<SqliteSignalRepo["compareAndSwapState"]>[0]
) {
  const signal = repos.signalRepo.compareAndSwapState(input);
  if (signal === null) {
    throw transitionConflict("Source-grounding signal state changed concurrently.");
  }
  return signal;
}

function assertClaimOwner(
  repos: TransitionRepos,
  workspaceId: string,
  signalId: string,
  claimToken: string | undefined
): void {
  if (claimToken === undefined) return;
  if (!repos.queueRepo.ownsClaim(workspaceId, signalId, claimToken)) {
    throw transitionConflict("Source-grounding redrive claim is not owned by this attempt.");
  }
}

function assertSharedStorageConnection(repos: TransitionRepos): void {
  const identities: StorageDatabase[] = [
    repos.eventLogRepo.getStorageConnectionIdentity(),
    repos.signalRepo.getStorageConnectionIdentity(),
    repos.queueRepo.getStorageConnectionIdentity()
  ];
  if (identities.some((identity) => identity !== identities[0])) {
    throw transitionConflict("Source-grounding transitions require one shared StorageDatabase.");
  }
}

function transitionConflict(message: string): CoreError {
  return new CoreError("CONFLICT", message, { subCode: "CONCURRENT_MODIFICATION" });
}
