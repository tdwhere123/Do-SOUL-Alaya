import { sourceGoldRootIdentity, type RecallNavigationWitness, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import type { NativeSourceNomination, ObserverReaders, SourceRootObserverPage } from "../conditional-field/observers/observe-ports.js";
import { CoreError } from "../../shared/errors.js";

/** A frozen nomination inventory is a read frontier, never a new discovery cursor. */
export function nativeSourceReaders(readers: ObserverReaders, captured: NativeSourceNomination | null,
  meter: SourceSemanticResourceLedger): ObserverReaders {
  const witnesses = new Map<string, RecallNavigationWitness>();
  const positions = { lexical: 0, vector: 0 };
  for (const occurrence of captured?.witness ?? []) {
    const route = occurrence.route;
    const digest = captured!.navigation_digests?.[occurrence.view]
      ?? (occurrence.view === "original" ? captured!.result?.navigation_digest : undefined);
    if (digest == null) throw new CoreError("OBLIGATION_VIOLATION", "Native nomination lacks its captured query digest");
    const key = occurrence.source.root_key, ordinal = positions[route.kind]++;
    meter.charge(1, 0, "native observation witness lookup");
    // Keep actual route ordinals, but allocate only the first-admission witness
    // this reader uses. The complete occurrence stream remains with its producer.
    if (witnesses.has(key)) continue;
    const navigation: RecallNavigationWitness = {
      contract: "native-query-navigation.v1",
      query_digest: digest,
      view: occurrence.view,
      operator: route.kind === "lexical" ? "source_lexical" : "source_vector",
      ordinal, native_rank: route.native_rank, reference: occurrence.reference,
      ...(route.kind !== "vector" || route.window?.status !== "available" ? {} : {
        location: { start_byte: route.window.window.start_byte, end_byte: route.window.window.end_byte }
      })
    };
    meter.retain(navigation, "native observation navigation");
    meter.charge(1, 40, "native observation witness reference");
    witnesses.set(key, navigation);
  }
  const roots = captured?.admitted_roots, nominations = captured?.result?.nominations;
  // Retain the producer's arrays; do not construct another target-only inventory.
  meter.charge(0, 16, "native source frontier references");
  const rootCount = roots?.length ?? nominations?.length ?? 0;
  meter.charge(1, 64 + Object.keys(readers).length * 8, "native source reader frame");
  // A failed nomination has no frozen inventory to enumerate. Source discovery is
  // then explicitly unavailable (the observation residual owns that fact), and the
  // independently supported memory lane must keep running instead of being closed
  // by a source-root reader that can only report unavailability.
  if (captured === null) {
    return { ...readers, boundInterpretations: undefined, sourceTextHints: undefined, sourceRoots: undefined };
  }
  return { ...readers, boundInterpretations: undefined, sourceTextHints: undefined,
    sourceRoots: input => {
      const empty: SourceRootObserverPage = { rows: [], nativeVisits: 0, nativeBytes: 0,
        rowsRead: 0, bytesRead: 0, truncated: false, committedThrough: input.afterCursor };
      if (readers.sourceRoot === undefined) return { ...empty, unavailable: true };
      const offset = input.afterCursor === null ? 0 : Number(input.afterCursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Invalid frozen source nomination cursor");
      const target = roots === undefined ? nominations?.[offset]?.source.target : roots[offset];
      if (target === undefined) return empty;
      const key = roots === undefined ? nominations![offset]!.source.root_key : sourceGoldRootIdentity(target);
      const navigation = witnesses.get(key);
      if (navigation === undefined && captured.admitted_roots === undefined) {
        throw new CoreError("OBLIGATION_VIOLATION", "Native nomination lacks its retained witness");
      }
      const page = readers.sourceRoot({ purpose: "observation", workspaceId: input.workspaceId, rootKind: target.root_kind,
        rootId: target.root_id, revision: target.source_version, digest: target.content_digest,
        evidenceObjectId: target.evidence_object_id, offset: 0,
        byteLimit: input.byteLimit, nativeByteLimit: input.nativeByteLimit, workLimit: input.workLimit });
      const retry = page.resourceLimited === true && page.row === null;
      return { rows: page.row === null ? [] : [{ ...page.row, navigation }],
        nativeVisits: page.nativeWork ?? page.rowsRead, nativeWork: page.nativeWork ?? page.rowsRead,
        nativeBytes: page.bytesRead + (page.metadataBytes ?? 0), rowsRead: page.rowsRead,
        bytesRead: page.bytesRead, metadataBytes: page.metadataBytes,
        unavailable: page.unavailable, resourceLimited: retry,
        truncated: retry || offset + 1 < rootCount,
        committedThrough: retry ? input.afterCursor : String(offset + 1) };
    }
  };
}
