import { afterEach, describe, expect, it } from "vitest";
import { CoreError, EventPublisher } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  requireAtomicKarmaTransition,
  type AtomicKarmaTransitionWiring
} from "../../runtime/karma-atomic-wiring-guard.js";

const SHARED_CONNECTION_IDENTITY = { connection: "shared" };

class StorageConnectionIdentityStub {
  public constructor(private readonly identity: object | undefined) {}

  public getStorageConnectionIdentity(): object | undefined {
    return this.identity;
  }
}

function buildIdentityWiring(
  eventPublisherIdentity: object | undefined,
  eventLogRepoIdentity: object | undefined,
  karmaEventRepoIdentity: object | undefined,
  memoryRepoIdentity: object | undefined
): AtomicKarmaTransitionWiring {
  return {
    eventPublisher: new StorageConnectionIdentityStub(eventPublisherIdentity),
    eventLogRepo: new StorageConnectionIdentityStub(eventLogRepoIdentity),
    karmaEventRepo: new StorageConnectionIdentityStub(karmaEventRepoIdentity),
    memoryRepo: new StorageConnectionIdentityStub(memoryRepoIdentity)
  };
}

const openDatabases: StorageDatabase[] = [];

function openDatabase(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  openDatabases.push(database);
  return database;
}

function buildEventPublisher(eventLogRepo: SqliteEventLogRepo): EventPublisher {
  return new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier: { notify: () => {}, notifyEntry: () => {} }
  });
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe("requireAtomicKarmaTransition", () => {
  it("accepts the daemon wiring: one connection yields an atomic-capable engine", () => {
    const database = openDatabase();
    const eventLogRepo = new SqliteEventLogRepo(database);
    const karmaEventRepo = new SqliteKarmaEventRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const eventPublisher = buildEventPublisher(eventLogRepo);

    expect(() =>
      requireAtomicKarmaTransition({ eventPublisher, eventLogRepo, karmaEventRepo, memoryRepo })
    ).not.toThrow();

    // Prerequisites of KarmaTransitionEngine.canRunAtomicTransition() are met, so
    // the engine built from this wiring takes the single-transaction atomic branch.
    expect(typeof karmaEventRepo.createSync).toBe("function");
    expect(typeof memoryRepo.updateDynamicsSync).toBe("function");
    expect(typeof memoryRepo.reviveDormantSync).toBe("function");
  });

  it("throws when the EventPublisher is backed by a second StorageDatabase", () => {
    const database = openDatabase();
    const eventLogRepo = new SqliteEventLogRepo(database);
    const karmaEventRepo = new SqliteKarmaEventRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);

    const otherDatabase = openDatabase();
    const mismatchedEventPublisher = buildEventPublisher(new SqliteEventLogRepo(otherDatabase));

    expect(() =>
      requireAtomicKarmaTransition({
        eventPublisher: mismatchedEventPublisher,
        eventLogRepo,
        karmaEventRepo,
        memoryRepo
      })
    ).toThrow(CoreError);
  });

  it.each([
    ["eventPublisher", undefined, SHARED_CONNECTION_IDENTITY, SHARED_CONNECTION_IDENTITY, SHARED_CONNECTION_IDENTITY],
    ["eventLogRepo", SHARED_CONNECTION_IDENTITY, undefined, SHARED_CONNECTION_IDENTITY, SHARED_CONNECTION_IDENTITY],
    ["karmaEventRepo", SHARED_CONNECTION_IDENTITY, SHARED_CONNECTION_IDENTITY, undefined, SHARED_CONNECTION_IDENTITY],
    ["memoryRepo", SHARED_CONNECTION_IDENTITY, SHARED_CONNECTION_IDENTITY, SHARED_CONNECTION_IDENTITY, undefined]
  ] as const)(
    "throws when %s does not report a storage connection identity",
    (_label, eventPublisherIdentity, eventLogRepoIdentity, karmaEventRepoIdentity, memoryRepoIdentity) => {
      expect(() =>
        requireAtomicKarmaTransition(
          buildIdentityWiring(
            eventPublisherIdentity,
            eventLogRepoIdentity,
            karmaEventRepoIdentity,
            memoryRepoIdentity
          )
        )
      ).toThrow(
        expect.objectContaining({
          name: "CoreError",
          code: "CONFLICT",
          subCode: "PORT_UNAVAILABLE",
          message: expect.stringMatching(/storage connection identity/u)
        })
      );
    }
  );

  it("throws when a karma repo is backed by a second StorageDatabase", () => {
    const database = openDatabase();
    const eventLogRepo = new SqliteEventLogRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const eventPublisher = buildEventPublisher(eventLogRepo);

    const otherDatabase = openDatabase();
    const mismatchedKarmaRepo = new SqliteKarmaEventRepo(otherDatabase);

    expect(() =>
      requireAtomicKarmaTransition({
        eventPublisher,
        eventLogRepo,
        karmaEventRepo: mismatchedKarmaRepo,
        memoryRepo
      })
    ).toThrow(/share one StorageDatabase connection/u);
  });
});
