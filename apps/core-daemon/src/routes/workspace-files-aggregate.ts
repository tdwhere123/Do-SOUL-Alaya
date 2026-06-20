interface AggregatedChangedFile {
  readonly path: string;
  readonly tool_call_ids: readonly string[];
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

export function aggregateChangedFiles(
  records: readonly {
    readonly execution_id: string;
    readonly affected_paths?: readonly string[] | null;
    readonly started_at?: string;
    readonly ended_at?: string;
  }[]
): readonly AggregatedChangedFile[] {
  const filesByPath = new Map<
    string,
    {
      path: string;
      toolCallIds: Set<string>;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  >();

  for (const record of records) {
    const lastSeenAt = record.ended_at ?? record.started_at;
    const affectedPaths = record.affected_paths;

    if (lastSeenAt === undefined || affectedPaths == null || affectedPaths.length === 0) {
      continue;
    }

    for (const affectedPath of affectedPaths) {
      const existing = filesByPath.get(affectedPath);

      if (existing === undefined) {
        filesByPath.set(affectedPath, {
          path: affectedPath,
          toolCallIds: new Set([record.execution_id]),
          firstSeenAt: lastSeenAt,
          lastSeenAt
        });
        continue;
      }

      existing.toolCallIds.add(record.execution_id);
      existing.firstSeenAt =
        existing.firstSeenAt < lastSeenAt ? existing.firstSeenAt : lastSeenAt;
      existing.lastSeenAt =
        existing.lastSeenAt > lastSeenAt ? existing.lastSeenAt : lastSeenAt;
    }
  }

  return Array.from(filesByPath.values())
    .map((entry) => ({
      path: entry.path,
      tool_call_ids: Array.from(entry.toolCallIds).sort(),
      first_seen_at: entry.firstSeenAt,
      last_seen_at: entry.lastSeenAt
    }))
    .sort(
      (left, right) =>
        right.last_seen_at.localeCompare(left.last_seen_at) ||
        left.path.localeCompare(right.path)
    );
}
