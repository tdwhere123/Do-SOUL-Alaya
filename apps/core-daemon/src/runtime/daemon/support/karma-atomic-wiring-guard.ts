import { CoreError } from "@do-soul/alaya-core";

interface StorageConnectionIdentitySource {
  getStorageConnectionIdentity?(): object | undefined;
}

export interface AtomicKarmaTransitionWiring {
  readonly eventPublisher: StorageConnectionIdentitySource;
  readonly eventLogRepo: StorageConnectionIdentitySource;
  readonly karmaEventRepo: StorageConnectionIdentitySource;
  readonly memoryRepo: StorageConnectionIdentitySource;
}

// invariant (§7): the karma write + its EventLog audit rows commit in ONE SQLite
// transaction only when the EventPublisher and the karma/memory/event-log repos
// share ONE StorageDatabase connection. Nothing else enforces this, so a future
// production mis-wire must fail fast here rather than silently drop to the
// non-atomic async path.
export function requireAtomicKarmaTransition(wiring: AtomicKarmaTransitionWiring): void {
  const identities = [
    wiring.eventPublisher.getStorageConnectionIdentity?.(),
    wiring.eventLogRepo.getStorageConnectionIdentity?.(),
    wiring.karmaEventRepo.getStorageConnectionIdentity?.(),
    wiring.memoryRepo.getStorageConnectionIdentity?.()
  ];

  if (identities.some((identity) => identity === undefined)) {
    throw new CoreError(
      "CONFLICT",
      "Atomic karma transition wiring requires every participant to report a storage connection identity; one participant did not, so single-transaction atomicity cannot be proven.",
      { subCode: "PORT_UNAVAILABLE" }
    );
  }

  if (identities.some((identity) => identity !== identities[0])) {
    throw new CoreError(
      "CONFLICT",
      "Atomic karma transition requires the EventPublisher and the karma, memory, and event-log repos to share one StorageDatabase connection.",
      { subCode: "PORT_UNAVAILABLE" }
    );
  }
}
