import { createHash } from "node:crypto";
import { ConstitutionalFragmentIdSchema, ConstitutionalFragmentSchema, EventLogEntrySchema, type ConstitutionalFragment, type EventLogEntry } from "@do-soul/alaya-protocol";
import { expect, vi } from "vitest";
import { requireAt } from "../helpers/defined.js";
import { type ConstitutionalFragmentStorePort } from "../../governance/policy/constitutional-fragment-service.js";
import { EventPublisher } from "../../runtime/event-publisher.js";

export const FIXED_NOW = "2026-04-17T02:00:00.000Z";

export const FIXED_LATER = "2026-04-17T08:45:00.000Z";

export function createStore(): ConstitutionalFragmentStorePort {
  const fragments: ConstitutionalFragment[] = [];

  const registerImpl = (fragment: ConstitutionalFragment): Readonly<ConstitutionalFragment> => {
    const parsed = ConstitutionalFragmentSchema.parse(fragment);
    const existingIndex = fragments.findIndex(
      (candidate) => candidate.fragment_id === parsed.fragment_id
    );

    if (existingIndex >= 0) {
      const existing = requireAt(fragments, existingIndex);
      expect(existing).toEqual(parsed);
      return existing;
    }

    fragments.push(parsed);
    return parsed;
  };

  return {
    findById: async (fragmentId) =>
      fragments.find((fragment) => fragment.fragment_id === fragmentId) ?? null,
    register: async (fragment) => registerImpl(fragment),
    registerSync: registerImpl,
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

export function createEventPublisher(
  entries: EventLogEntry[],
  options: { readonly beforeReturn?: () => Promise<void> } = {}
): Pick<EventPublisher, "appendManyWithMutation"> {
  const buildEntry = (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry =>
    EventLogEntrySchema.parse({
      ...event,
      event_id: `event-${entries.length + 1}`,
      created_at: FIXED_NOW,
      revision: entries.length
    });

  // In-memory adapter mimicking better-sqlite3 transactional semantics so
  // EventPublisher.appendManyWithMutation can run mutate synchronously and
  // we can still inject async gating between transaction commit and the
  // post-commit `await this.propagate(entry)`.
  const eventLogRepo = {
    append: vi.fn((event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const entry = buildEntry(event);
      entries.push(entry);
      return entry;
    }),
    deleteById: vi.fn((eventId: string) => {
      const index = entries.findIndex((entry) => entry.event_id === eventId);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    }),
    transactional: <T,>(fn: () => T): T => fn()
  };

  const propagate = options.beforeReturn ?? (async () => undefined);
  const publisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: {
      apply: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof EventPublisher>[0]["runHotStateService"],
    runtimeNotifier: {
      notify: vi.fn(async () => undefined),
      notifyEntry: vi.fn(async () => {
        await propagate();
      })
    }
  });

  return {
    appendManyWithMutation: publisher.appendManyWithMutation.bind(publisher)
  };
}

export function createContentAddressedFragmentId({
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

export function createDefaultFragmentId(input: {
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

export function parseFragmentId(value: string): ConstitutionalFragment["fragment_id"] {
  return ConstitutionalFragmentIdSchema.parse(value);
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
