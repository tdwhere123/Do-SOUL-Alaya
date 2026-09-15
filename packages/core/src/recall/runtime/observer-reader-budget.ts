import type { ObserverReaders, SourceObserverPage } from "../conditional-field/observers/observe.js";

export function meterReaders(
  readers: ObserverReaders,
  memory: { remaining: number; cachedBytes: number },
  cache: Map<string, SourceObserverPage>
): ObserverReaders {
  const source = readers.source;
  return {
    ...readers,
    ...(readers.boundInterpretations === undefined ? {} : {
      boundInterpretations: (args: Parameters<NonNullable<ObserverReaders["boundInterpretations"]>>[0]) => {
        const page = readers.boundInterpretations!({ ...args, nativeByteLimit: memory.remaining });
        memory.remaining = Math.max(0, memory.remaining - page.bytesRead - (page.nativeBytes ?? 0));
        return page;
      }
    }),
    ...(readers.sourceTextHints === undefined ? {} : {
      sourceTextHints: (args: Parameters<NonNullable<ObserverReaders["sourceTextHints"]>>[0]) => {
        const page = readers.sourceTextHints!({ ...args, nativeByteLimit: memory.remaining });
        memory.remaining = Math.max(0, memory.remaining - page.bytesRead - (page.nativeBytes ?? 0));
        return page;
      }
    }),
    ...(readers.sourceRoot === undefined ? {} : {
      sourceRoot: (args: Parameters<NonNullable<ObserverReaders["sourceRoot"]>>[0]) => {
        const page = readers.sourceRoot!({ ...args, nativeByteLimit: memory.remaining });
        memory.remaining = Math.max(0, memory.remaining - page.bytesRead - (page.metadataBytes ?? 0));
        return page;
      }
    }),
    ...(readers.embeddingIds === undefined ? {} : {
      embeddingIds: (args: Parameters<NonNullable<ObserverReaders["embeddingIds"]>>[0]) => {
        const page = readers.embeddingIds!({ ...args, byteLimit: memory.remaining });
        memory.remaining = Math.max(0, memory.remaining - page.metadataUtf8Bytes);
        return page;
      }
    }),
    ...(readers.measureStoredPair === undefined ? {} : {
      measureStoredPair: (args: Parameters<NonNullable<ObserverReaders["measureStoredPair"]>>[0]) => {
        const page = readers.measureStoredPair!({ ...args, byteLimit: Math.min(args.byteLimit ?? 137472, memory.remaining) });
        memory.remaining = Math.max(0, memory.remaining - page.bytesRead);
        return page;
      }
    }),
    ...(source === undefined ? {} : { source: (args: Parameters<NonNullable<ObserverReaders["source"]>>[0]) => {
      const hit = cache.get(args.objectId);
      if (hit !== undefined) return { ...hit, rowsRead: 0, bytesRead: 0 };
      const byteLimit = Math.min(args.byteLimit ?? 65536, 65536, memory.remaining);
      if (byteLimit < 1) return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      const page = source({ ...args, byteLimit });
      memory.remaining = Math.max(0, memory.remaining - page.bytesRead);
      memory.cachedBytes += page.bytesRead;
      cache.set(args.objectId, page);
      return page;
    } }),
    ...(readers.sourceRoots === undefined ? {} : {
      sourceRoots: (args: Parameters<NonNullable<ObserverReaders["sourceRoots"]>>[0]) => {
        const byteLimit = Math.min(args.byteLimit ?? 65536, 65536,
          memory.remaining - (readers.sourceRootMetadataByteLimit ?? 0));
        if (byteLimit < 1) return { rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
          truncated: true, committedThrough: args.afterCursor, resourceLimited: true };
        const physicalBytes = readers.sourceRootChunkByteLimit ?? byteLimit;
        const limit = Math.min(args.limit, Math.floor(memory.remaining / (physicalBytes + (readers.sourceRootMetadataByteLimit ?? 0))));
        const page = readers.sourceRoots!({ ...args, byteLimit, nativeByteLimit: memory.remaining,
          limit, nativeLimit: Math.min(args.nativeLimit, limit) });
        const bytes = page.bytesRead + (page.metadataBytes ?? 0);
        memory.remaining = Math.max(0, memory.remaining - bytes);
        return page;
      }
    })
  };
}
