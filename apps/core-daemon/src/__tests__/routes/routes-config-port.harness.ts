import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import type { ConfigRepo } from "@do-soul/alaya-storage";
import { createConfigService } from "../../services/config/config-service.js";
import { resolveAlayaConfigPaths, type AlayaConfigPaths } from "../../cli/support/config-files.js";

export async function createServiceHarness(options: {
  readonly platform?: NodeJS.Platform;
  readonly tempIds?: readonly string[];
  readonly repo?: ConfigRepo;
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<{
  readonly service: ReturnType<typeof createConfigService>;
  readonly paths: AlayaConfigPaths;
  readonly publishedEvents: EventLogEntry[];
  readonly appendManyWithMutation: ReturnType<typeof vi.fn>;
}> {
  const repo = options.repo ?? createMemoryConfigRepo();
  const configDir = await mkdtemp(path.join(tmpdir(), "daemon-config-"));
  const paths = resolveAlayaConfigPaths(configDir);
  const publishedEvents: EventLogEntry[] = [];
  const appendManyWithMutation = vi.fn(
    async <T>(
      events: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T> => {
      const persisted = events.map(
        (event, idx) =>
          ({
            ...event,
            event_id: `event-${publishedEvents.length + idx + 1}`,
            created_at: "2026-05-01T00:00:00.000Z",
            revision: publishedEvents.length + idx + 1
          }) as EventLogEntry
      );
      // Snapshot length before the mutate so a thrown mutate cleanly rolls
      // back the appended rows (mirrors EventPublisher.appendManyWithMutation
      // transactional semantics in tests that don't wire a real publisher).
      const before = publishedEvents.length;
      publishedEvents.push(...persisted);
      try {
        return mutate(persisted);
      } catch (error) {
        publishedEvents.length = before;
        throw error;
      }
    }
  );
  let tempIndex = 0;
  return {
    service: createConfigService({
      configRepo: repo,
      eventPublisher: {
        appendManyWithMutation
      } as Parameters<typeof createConfigService>[0]["eventPublisher"],
      configPathsProvider: () => paths,
      clock: () => "2026-05-01T00:00:00.000Z",
      platform: options.platform,
      generateAuditId: () => `audit-${publishedEvents.length + 1}`,
      generateTempId: () => options.tempIds?.[tempIndex++] ?? `tmp-${tempIndex++}`,
      envProvider: () => options.env ?? process.env
    }),
    paths,
    publishedEvents,
    appendManyWithMutation
  };
}

export function createMemoryConfigRepo(): ConfigRepo {
  const values = new Map<string, unknown>();
  const getParsed = <T,>(key: string, parser: { parse(value: unknown): T }): T | null => {
    const value = values.get(key);
    return value === undefined ? null : parser.parse(value);
  };
  const setParsed = <T,>(key: string, value: T, parser: { parse(value: unknown): T }): T => {
    const parsed = parser.parse(value);
    values.set(key, parsed);
    return parsed;
  };
  const patchParsed = <T extends Record<string, unknown>>(
    key: string,
    partial: Partial<T>,
    defaults: T,
    parser: { parse(value: unknown): T }
  ): T => {
    const current = getParsed(key, parser) ?? parser.parse(defaults);
    const next = parser.parse({ ...current, ...partial });
    setParsed(key, next, parser);
    return next;
  };
  return {
    getParsed,
    setParsed,
    patchParsed
  };
}
