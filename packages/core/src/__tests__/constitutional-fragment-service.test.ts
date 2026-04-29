import { createHash } from "node:crypto";
import {
  ConstitutionalFragmentIdSchema,
  ConstitutionalFragmentRegisteredPayloadSchema,
  ConstitutionalFragmentSchema,
  ConstitutionalFragmentRegistrationSchema,
  EventLogEntrySchema,
  PhaseCEventType,
  type ConstitutionalFragment,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { ConstitutionalFragmentService, type ConstitutionalFragmentStorePort } from "../constitutional-fragment-service.js";
import { EventPublisher } from "../event-publisher.js";

const FIXED_NOW = "2026-04-17T02:00:00.000Z";
const FIXED_LATER = "2026-04-17T08:45:00.000Z";

describe("ConstitutionalFragmentService", () => {
  it("registers immutable fragments, writes constitutional.fragment_registered through EventLog, and filters by workspace/category", async () => {
    const store = createStore();
    const eventLogEntries: EventLogEntry[] = [];
    const service = new ConstitutionalFragmentService({
      fragmentStore: store,
      eventPublisher: createEventPublisher(eventLogEntries),
      now: () => FIXED_NOW,
      generateFragmentId: ({ workspace_id, category, authority_source }) =>
        parseFragmentId(`constitutional://${workspace_id}/${category}/${authority_source}`)
    });

    expect(() =>
      ConstitutionalFragmentSchema.parse({
        fragment_id: "fragment-1",
        workspace_id: "workspace-1",
        category: "hard_constraint",
        content: "Never execute unsafe shell fragments.",
        authority_source: "system",
        immutable: false,
        registered_at: FIXED_NOW
      })
    ).toThrow();

    const hardConstraint = await service.register(
      ConstitutionalFragmentRegistrationSchema.parse({
        workspace_id: "workspace-1",
        category: "hard_constraint",
        content: "Never execute unsafe shell fragments.",
        authority_source: "system"
      })
    );
    const baselinePolicy = await service.register(
      ConstitutionalFragmentRegistrationSchema.parse({
        workspace_id: "workspace-1",
        category: "baseline_policy",
        content: "Prefer explicit verification evidence over assumptions.",
        authority_source: "operator"
      })
    );
    await service.register(
      ConstitutionalFragmentRegistrationSchema.parse({
        workspace_id: "workspace-2",
        category: "operational_principle",
        content: "Stay concise by default.",
        authority_source: "operator"
      })
    );

    expect(hardConstraint).toEqual(
      ConstitutionalFragmentSchema.parse({
        fragment_id: "constitutional://workspace-1/hard_constraint/system",
        workspace_id: "workspace-1",
        category: "hard_constraint",
        content: "Never execute unsafe shell fragments.",
        authority_source: "system",
        immutable: true,
        registered_at: FIXED_NOW
      })
    );
    expect(Object.isFrozen(hardConstraint)).toBe(true);
    expect(baselinePolicy.immutable).toBe(true);

    await expect(service.listForWorkspace("workspace-1")).resolves.toEqual([
      hardConstraint,
      baselinePolicy
    ]);
    await expect(service.listByCategory("workspace-1", "hard_constraint")).resolves.toEqual([
      hardConstraint
    ]);
    await expect(
      service.listByCategory("workspace-1", "operational_principle")
    ).resolves.toEqual([]);

    expect(eventLogEntries).toHaveLength(3);
    expect(EventLogEntrySchema.parse(eventLogEntries[0])).toEqual(eventLogEntries[0]);
    expect(eventLogEntries[0]).toEqual(
      expect.objectContaining({
        event_type: PhaseCEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
        entity_type: "constitutional_fragment",
        entity_id: "constitutional://workspace-1/hard_constraint/system",
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "system",
        revision: 0
      })
    );
    expect(ConstitutionalFragmentRegisteredPayloadSchema.parse(eventLogEntries[0].payload_json)).toEqual({
      fragment_id: "constitutional://workspace-1/hard_constraint/system",
      workspace_id: "workspace-1",
      category: "hard_constraint",
      authority_source: "system",
      registered_at: FIXED_NOW,
      content_sha256: hashContent("Never execute unsafe shell fragments.")
    });
  });

  it("hydrates existing durable static fragment registrations without re-emitting registration events", async () => {
    const store = createStore();
    const existingEntry = EventLogEntrySchema.parse({
      event_id: "event-1",
      event_type: PhaseCEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
      entity_type: "constitutional_fragment",
      entity_id: "constitutional://workspace-1/hard_constraint/system.worker_dispatch",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "system",
      revision: 0,
        payload_json: ConstitutionalFragmentRegisteredPayloadSchema.parse({
          fragment_id: "constitutional://workspace-1/hard_constraint/system.worker_dispatch",
          workspace_id: "workspace-1",
          category: "hard_constraint",
          authority_source: "system.worker_dispatch",
          registered_at: FIXED_NOW,
          content_sha256: hashContent("Never mutate files outside approved workspace roots.")
        }),
        created_at: FIXED_NOW
      });
    const publishWithMutationImpl: Pick<EventPublisher, "publishWithMutation">["publishWithMutation"] =
      async (_event, mutate) => await mutate();
    const publishWithMutation = vi.fn(publishWithMutationImpl);
    const eventLogReader = {
      queryByEntity: vi.fn(async (entityType: string, entityId: string) =>
        entityType === "constitutional_fragment" && entityId === existingEntry.entity_id
          ? [existingEntry]
          : []
      )
    };
    const service = new ConstitutionalFragmentService({
      fragmentStore: store,
      eventPublisher: {
        publishWithMutation:
          publishWithMutation as Pick<EventPublisher, "publishWithMutation">["publishWithMutation"]
      },
      eventLogReader,
      now: () => FIXED_LATER,
      generateFragmentId: ({ workspace_id, category, authority_source }) =>
        parseFragmentId(`constitutional://${workspace_id}/${category}/${authority_source}`)
    });

    const hydrated = await service.ensureRegistered(
      ConstitutionalFragmentRegistrationSchema.parse({
        workspace_id: "workspace-1",
        category: "hard_constraint",
        content: "Never mutate files outside approved workspace roots.",
        authority_source: "system.worker_dispatch"
      })
    );

    expect(hydrated).toEqual(
      ConstitutionalFragmentSchema.parse({
        fragment_id: "constitutional://workspace-1/hard_constraint/system.worker_dispatch",
        workspace_id: "workspace-1",
        category: "hard_constraint",
        content: "Never mutate files outside approved workspace roots.",
        authority_source: "system.worker_dispatch",
        immutable: true,
        registered_at: FIXED_NOW
      })
    );
    expect(eventLogReader.queryByEntity).toHaveBeenCalledWith(
      "constitutional_fragment",
      "constitutional://workspace-1/hard_constraint/system.worker_dispatch"
    );
    expect(publishWithMutation).not.toHaveBeenCalled();
    await expect(service.listForWorkspace("workspace-1")).resolves.toEqual([hydrated]);
  });

  it("treats static fragment text drift as a new audited registration when ids are content-addressed", async () => {
    const previousContent =
      "Never mutate files outside approved workspace roots.";
    const nextContent =
      "Never mutate files outside approved workspace roots or hidden symlink targets.";
    const previousId = createContentAddressedFragmentId({
      workspace_id: "workspace-1",
      category: "hard_constraint",
      authority_source: "system.worker_dispatch",
      content: previousContent
    });
    const nextId = createContentAddressedFragmentId({
      workspace_id: "workspace-1",
      category: "hard_constraint",
      authority_source: "system.worker_dispatch",
      content: nextContent
    });
    const store = createStore();
    const publishedEvents: EventLogEntry[] = [
      EventLogEntrySchema.parse({
        event_id: "event-1",
        event_type: PhaseCEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
        entity_type: "constitutional_fragment",
        entity_id: previousId,
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "system",
        revision: 0,
        payload_json: ConstitutionalFragmentRegisteredPayloadSchema.parse({
          fragment_id: previousId,
          workspace_id: "workspace-1",
          category: "hard_constraint",
          authority_source: "system.worker_dispatch",
          registered_at: FIXED_NOW,
          content_sha256: hashContent(previousContent)
        }),
        created_at: FIXED_NOW
      })
    ];
    const service = new ConstitutionalFragmentService({
      fragmentStore: store,
      eventPublisher: createEventPublisher(publishedEvents),
      eventLogReader: {
        queryByEntity: vi.fn(async (entityType: string, entityId: string) =>
          entityType === "constitutional_fragment" && entityId === previousId
            ? [publishedEvents[0]]
            : []
        )
      },
      now: () => FIXED_LATER,
      generateFragmentId: createContentAddressedFragmentId
    });

    const drifted = await service.ensureRegistered(
      ConstitutionalFragmentRegistrationSchema.parse({
        workspace_id: "workspace-1",
        category: "hard_constraint",
        content: nextContent,
        authority_source: "system.worker_dispatch"
      })
    );

    expect(drifted.fragment_id).toBe(nextId);
    expect(drifted.content).toBe(nextContent);
    expect(drifted.registered_at).toBe(FIXED_LATER);
    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[1]).toEqual(
      expect.objectContaining({
        event_type: PhaseCEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
        entity_id: nextId,
        workspace_id: "workspace-1"
      })
    );
  });

  it("coalesces concurrent ensureRegistered calls so a static fragment emits one audit event", async () => {
    const registeredFragments = new Map<string, ConstitutionalFragment>();
    let releaseFirstRegister: (() => void) | undefined;
    const firstRegisterBlocked = new Promise<void>((resolve) => {
      releaseFirstRegister = resolve;
    });
    let registerCalls = 0;
    const store: ConstitutionalFragmentStorePort = {
      findById: async (fragmentId) => registeredFragments.get(fragmentId) ?? null,
      register: async (fragment) => {
        const parsed = ConstitutionalFragmentSchema.parse(fragment);
        registerCalls += 1;
        if (registerCalls === 1) {
          await firstRegisterBlocked;
        }

        const existing = registeredFragments.get(parsed.fragment_id);
        if (existing !== undefined) {
          expect(existing).toEqual(parsed);
          return existing;
        }

        registeredFragments.set(parsed.fragment_id, parsed);
        return parsed;
      },
      findByWorkspace: async (workspaceId) =>
        Object.freeze(
          [...registeredFragments.values()].filter((fragment) => fragment.workspace_id === workspaceId)
        ),
      findByCategory: async (workspaceId, category) =>
        Object.freeze(
          [...registeredFragments.values()].filter(
            (fragment) => fragment.workspace_id === workspaceId && fragment.category === category
          )
        )
    };
    const eventLogEntries: EventLogEntry[] = [];
    const service = new ConstitutionalFragmentService({
      fragmentStore: store,
      eventPublisher: createEventPublisher(eventLogEntries),
      now: () => FIXED_NOW,
      generateFragmentId: ({ workspace_id, category, authority_source }) =>
        parseFragmentId(`constitutional://${workspace_id}/${category}/${authority_source}`)
    });
    const request = ConstitutionalFragmentRegistrationSchema.parse({
      workspace_id: "workspace-1",
      category: "hard_constraint",
      content: "Never execute unsafe shell fragments.",
      authority_source: "system"
    });

    const first = service.ensureRegistered(request);
    await vi.waitFor(() => {
      expect(eventLogEntries).toHaveLength(1);
    });
    const second = service.ensureRegistered(request);
    await Promise.resolve();
    await Promise.resolve();
    expect(eventLogEntries).toHaveLength(1);

    releaseFirstRegister?.();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(registerCalls).toBe(1);
    expect(eventLogEntries).toHaveLength(1);
  });

  it("uses a deterministic content-addressed fragment id by default", async () => {
    const eventLogEntries: EventLogEntry[] = [];
    const service = new ConstitutionalFragmentService({
      fragmentStore: createStore(),
      eventPublisher: createEventPublisher(eventLogEntries),
      now: () => FIXED_NOW
    });
    const request = ConstitutionalFragmentRegistrationSchema.parse({
      workspace_id: "workspace-1",
      category: "hard_constraint",
      content: "Never mutate files outside approved workspace roots.",
      authority_source: "system.worker_dispatch"
    });

    const first = await service.ensureRegistered(request);
    const second = await service.ensureRegistered(request);

    expect(first.fragment_id).toBe(createDefaultFragmentId(request));
    expect(second.fragment_id).toBe(first.fragment_id);
    expect(eventLogEntries).toHaveLength(1);
  });

  it("rejects restart rehydration when a stable fragment id resolves to drifted content without a new audit event", async () => {
    const stableId = parseFragmentId(
      "constitutional://workspace-1/hard_constraint/system.worker_dispatch"
    );
    const previousContent = "Never mutate files outside approved workspace roots.";
    const nextContent =
      "Never mutate files outside approved workspace roots or hidden symlink targets.";
    const store = createStore();
    const existingEntry = EventLogEntrySchema.parse({
      event_id: "event-1",
      event_type: PhaseCEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
      entity_type: "constitutional_fragment",
      entity_id: stableId,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "system",
      revision: 0,
      payload_json: ConstitutionalFragmentRegisteredPayloadSchema.parse({
        fragment_id: stableId,
        workspace_id: "workspace-1",
        category: "hard_constraint",
        authority_source: "system.worker_dispatch",
        registered_at: FIXED_NOW,
        content_sha256: hashContent(previousContent)
      }),
      created_at: FIXED_NOW
    });
    const publishWithMutationImpl: Pick<EventPublisher, "publishWithMutation">["publishWithMutation"] =
      async (_event, mutate) => await mutate();
    const publishWithMutation = vi.fn(publishWithMutationImpl);
    const service = new ConstitutionalFragmentService({
      fragmentStore: store,
      eventPublisher: {
        publishWithMutation:
          publishWithMutation as Pick<EventPublisher, "publishWithMutation">["publishWithMutation"]
      },
      eventLogReader: {
        queryByEntity: vi.fn(async () => [existingEntry])
      },
      now: () => FIXED_LATER,
      generateFragmentId: () => stableId
    });

    await expect(
      service.ensureRegistered(
        ConstitutionalFragmentRegistrationSchema.parse({
          workspace_id: "workspace-1",
          category: "hard_constraint",
          content: nextContent,
          authority_source: "system.worker_dispatch"
        })
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("content")
    });
    expect(publishWithMutation).not.toHaveBeenCalled();
    await expect(service.listForWorkspace("workspace-1")).resolves.toEqual([]);
  });
});

function createStore(): ConstitutionalFragmentStorePort {
  const fragments: ConstitutionalFragment[] = [];

  return {
    findById: async (fragmentId) =>
      fragments.find((fragment) => fragment.fragment_id === fragmentId) ?? null,
    register: async (fragment) => {
      const parsed = ConstitutionalFragmentSchema.parse(fragment);
      const existingIndex = fragments.findIndex(
        (candidate) => candidate.fragment_id === parsed.fragment_id
      );

      if (existingIndex >= 0) {
        expect(fragments[existingIndex]).toEqual(parsed);
        return fragments[existingIndex];
      }

      fragments.push(parsed);
      return parsed;
    },
    findByWorkspace: async (workspaceId) =>
      Object.freeze(
        fragments.filter((fragment) => fragment.workspace_id === workspaceId)
      ) as readonly Readonly<ConstitutionalFragment>[],
    findByCategory: async (workspaceId, category) =>
      Object.freeze(
        fragments.filter(
          (fragment) =>
            fragment.workspace_id === workspaceId && fragment.category === category
        )
      ) as readonly Readonly<ConstitutionalFragment>[]
  };
}

function createEventPublisher(entries: EventLogEntry[]): Pick<EventPublisher, "publishWithMutation"> {
  const eventLogRepo = {
    append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
      const entry = EventLogEntrySchema.parse({
        ...event,
        event_id: `event-${entries.length + 1}`,
        created_at: FIXED_NOW
      });
      entries.push(entry);
      return entry;
    }),
    deleteById: vi.fn(async (eventId: string) => {
      const index = entries.findIndex((entry) => entry.event_id === eventId);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    })
  };
  const publisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: {
      apply: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof EventPublisher>[0]["runHotStateService"],
    runtimeNotifier: {
      notify: vi.fn(async () => undefined),
      notifyEntry: vi.fn(async () => undefined)
    }
  });

  return {
    publishWithMutation: publisher.publishWithMutation.bind(publisher)
  };
}

function createContentAddressedFragmentId({
  workspace_id,
  category,
  authority_source,
  content
}: {
  workspace_id: string;
  category: string;
  authority_source: string;
  content: string;
}): ConstitutionalFragment["fragment_id"] {
  const contentToken = content
    .split("")
    .reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 17)
    .toString(16)
    .padStart(8, "0");

  return parseFragmentId(
    `constitutional://${workspace_id}/${category}/${authority_source}-${contentToken}`
  );
}

function createDefaultFragmentId(input: {
  workspace_id: string;
  category: string;
  authority_source: string;
  content: string;
}): ConstitutionalFragment["fragment_id"] {
  const authorityToken = input.authority_source.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const identityToken = createHash("sha256")
    .update(JSON.stringify([input.workspace_id, input.category, input.authority_source, input.content]))
    .digest("hex")
    .slice(0, 12);

  return parseFragmentId(
    `constitutional://${input.workspace_id}/${input.category}/${authorityToken}-${identityToken}`
  );
}

function parseFragmentId(value: string): ConstitutionalFragment["fragment_id"] {
  return ConstitutionalFragmentIdSchema.parse(value);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
