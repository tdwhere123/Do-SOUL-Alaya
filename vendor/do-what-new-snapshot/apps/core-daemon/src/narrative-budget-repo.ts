import { type NarrativeBudgetRepoPort } from "@do-what/core";
import { NarrativeDigestSchema } from "@do-what/protocol";

export interface NarrativeDigestEventLogReader {
  queryByRun(runId: string): Promise<readonly Readonly<{ payload_json: unknown }>[]>;
}

interface NarrativeDigestAggregate {
  readonly count: number;
  readonly totalBytes: number;
}

function aggregateNarrativeDigests(
  entries: readonly Readonly<{ payload_json: unknown }>[]
): Readonly<NarrativeDigestAggregate> {
  let count = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const parsed = NarrativeDigestSchema.safeParse(entry.payload_json);
    if (!parsed.success) {
      continue;
    }

    count += 1;
    totalBytes += Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
  }

  return Object.freeze({ count, totalBytes });
}

export function createNarrativeBudgetRepo(
  deps: Readonly<{ eventLogRepo: NarrativeDigestEventLogReader }>
): NarrativeBudgetRepoPort {
  const summaryByRunId = new Map<string, Promise<Readonly<NarrativeDigestAggregate>>>();

  const summarizeByRun = async (runId: string): Promise<Readonly<NarrativeDigestAggregate>> => {
    const cached = summaryByRunId.get(runId);
    if (cached !== undefined) {
      return await cached;
    }

    const started = deps.eventLogRepo
      .queryByRun(runId)
      .then((entries) => aggregateNarrativeDigests(entries))
      .finally(() => {
        setTimeout(() => {
          if (summaryByRunId.get(runId) === started) {
            summaryByRunId.delete(runId);
          }
        }, 0);
      });

    summaryByRunId.set(runId, started);
    return await started;
  };

  return {
    countDigestsByRun: async (runId: string) => (await summarizeByRun(runId)).count,
    totalDigestBytesByRun: async (runId: string) => (await summarizeByRun(runId)).totalBytes
  };
}
