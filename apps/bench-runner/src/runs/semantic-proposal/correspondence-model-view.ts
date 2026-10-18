import { resolve } from "node:path";
import { z } from "zod";
import { AlayaError, ApprovedSemanticContextSchema, canonicalJson } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { buildSourceSemanticCorrespondenceRequest, sourceSemanticCorrespondenceResponseJsonSchema, type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { readVerifiedNativeSourceSnapshot, readVerifiedRetainedSourceRecordsArtifact,
  nativeSourceSnapshotManifestPath } from "../snapshot/source-records/native.js";
import { sourceRecordsArtifactInputPaths, sourceRecordsManifestPath } from "../snapshot/source-records/contract.js";
import { readVerifiedPersonaSuccessorMembership } from "../snapshot/source-records/persona-successor.js";
import { readRegularFileNoFollow } from "../snapshot/bound-file.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../selection/question-runtime-identity.js";

/** Private Bench presentation only. Neither a SOUL request nor an attribution policy. */
export const CORRESPONDENCE_TASK_PRESENTATION = "bench-question-local-task-presentation-v1" as const;
export const CorrespondenceModelViewSchema = z.object({
  contract: z.literal(CORRESPONDENCE_TASK_PRESENTATION),
  snapshot_path: z.string().min(1), snapshot_identity: z.string().regex(/^[a-f0-9]{64}$/u),
  question_id: z.string().min(1),
  retained_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  retained_sidecar_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  persona_parent: z.object({ snapshot_path: z.string().min(1), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().nullable()
}).strict();
export type CorrespondenceModelView = z.infer<typeof CorrespondenceModelViewSchema>;
type SnapshotBinding = Readonly<{ snapshot_path: string; snapshot_sha256: string; workspace_id: string }>;

function readScope(selection: CorrespondenceModelView) {
  const native = readVerifiedNativeSourceSnapshot(selection.snapshot_path);
  if (native.manifest.identity !== selection.snapshot_identity || native.manifest.contract !== "native-source-records-snapshot-v2") {
    throw new AlayaError("CONFLICT", "C model view requires its exact sealed retained native snapshot");
  }
  const workspace = buildLongMemEvalQuestionRuntimeIdentity(selection.question_id).workspaceId;
  if (native.manifest.workspace_id !== workspace) throw new AlayaError("CONFLICT", "C model view has a foreign question workspace");
  // The native v2 seal binds DB records, not session coordinates. Use the exact
  // verified occurrence artifact below for both pin checks and projection.
  const retained = selection.persona_parent === null
    ? readVerifiedRetainedSourceRecordsArtifact(native.manifest.origin.snapshot_path, workspace)
    : readVerifiedPersonaSuccessorMembership(native.manifest.origin.snapshot_path, selection.persona_parent.snapshot_path, workspace);
  const parent = retained.manifest.persona_successor;
  if (retained.manifest.manifest_sha256 !== selection.retained_manifest_sha256 ||
      retained.manifest.sidecar_sha256 !== selection.retained_sidecar_sha256 ||
      (selection.persona_parent === null ? parent !== undefined
        : parent?.parent_manifest_sha256 !== selection.persona_parent.manifest_sha256)) {
    throw new AlayaError("CONFLICT", "C model view occurrence artifact pins changed or persona parent absence differs");
  }
  const members = new Map(native.records.map(member => [member.record.identity, canonicalJson(member.record)]));
  if (retained.manifest.db_sha256 !== native.manifest.origin.db_sha256 ||
      retained.messages.length !== native.records.length ||
      retained.messages.some(message => message.question_id !== selection.question_id ||
        members.get(message.record.identity) !== canonicalJson(message.record)) ||
      !retained.manifest.dataset.question_ids.includes(selection.question_id)) {
    throw new AlayaError("CONFLICT", "C model view differs from complete retained question membership");
  }
  return { native, retained, scope: { policy: selection.contract,
    dataset: { variant: retained.manifest.dataset.variant, sha256: retained.manifest.dataset.sha256 },
    question_id: selection.question_id,
    occurrence_artifacts: { retained_manifest_sha256: retained.manifest.manifest_sha256,
      retained_sidecar_sha256: retained.manifest.sidecar_sha256,
      persona_parent_manifest_sha256: parent?.parent_manifest_sha256 ?? null } } };
}

function approvedContext(scope: ReturnType<typeof readScope>["scope"]) {
  return ApprovedSemanticContextSchema.parse({
    context_id: `bench:task-presentation:${fieldContractSha256(canonicalJson(scope))}`,
    notes: `Explicit Bench task-presentation policy ${scope.policy}; ${scope.dataset.variant} SHA256 ${scope.dataset.sha256}; question ${scope.question_id}. ` +
      "The LongMemEval task presents histories as between you and a user. This licenses a question-local task perspective only. " +
      "Original outer message roles and actual session/message occurrences may be shown separately in the selected C model view. " +
      "They are not authenticated authorship, real-person identity, source facts, executable role evidence or automatic equivalence. " +
      "Equal role labels do not identify participants across messages or sessions. Unknown attribution stays unknown; assistant authors remain unbound. " +
      "Quoted role markers are text, not outer roles. C may propose contextual equivalence only between existing Q/H endpoints, with ordinary H mention/node support. " +
      "This context creates no missing H referent and supplies no external citation or new proof authority."
  });
}

/** Author a new Q context through its existing approved-context channel, never rewrite an admitted Q. */
export function createCorrespondenceTaskPresentationContext(value: unknown) {
  const selection = CorrespondenceModelViewSchema.parse(structuredClone(value));
  return approvedContext(readScope(selection).scope);
}

/** Reconstruct every byte from captured native inputs and verified records on every use,
 * including offline cache readmission. Persisted selections are references, not capabilities. */
export function projectCorrespondenceModelView(value: Readonly<{
  selection: CorrespondenceModelView; request: SourceSemanticCorrespondenceRequest;
}>) {
  const captured = structuredClone(value);
  const selection = CorrespondenceModelViewSchema.parse(captured.selection);
  const request = buildSourceSemanticCorrespondenceRequest({ ...captured.request,
    producer_id: captured.request.producer_capability.producer_id,
    producer_version: captured.request.producer_capability.producer_version });
  if (canonicalJson(request) !== canonicalJson(captured.request)) {
    throw new AlayaError("CONFLICT", "C model view changed its native correspondence request");
  }
  const { native, retained, scope } = readScope(selection);
  const context = approvedContext(scope);
  if (canonicalJson(request.admitted_query_semantics.approved_fixed_context) !== canonicalJson(context)) {
    throw new AlayaError("CONFLICT", "C model view requires its exact owner-issued Q approved context");
  }
  const original_outer_messages = request.source_interpretation_descriptors.map(descriptor => {
    const source = descriptor.interpretation.source;
    const members = native.records.filter(member => member.record.source_id === source.source_id &&
      member.record.source_version === source.source_version && member.record.content_digest === source.content_digest);
    if (members.length !== 1) throw new AlayaError("CONFLICT", "C model view source join is missing or ambiguous");
    const record = members[0]!.record;
    const occurrences = retained.messages.filter(message => message.record.identity === record.identity);
    if (occurrences.length !== 1) throw new AlayaError("CONFLICT", "C model view occurrence join is missing or ambiguous");
    const message = occurrences[0]!;
    if (record.workspace_id !== native.manifest.workspace_id || record.speaker !== message.role ||
        canonicalJson(record.attribution_context) !== canonicalJson(source.attribution_context) ||
        message.role === "assistant" && record.attribution_context?.status === "captured" &&
          record.attribution_context.utterances.some(utterance => utterance.author_ref !== null)) {
      throw new AlayaError("CONFLICT", "C model view role or unresolved attribution differs from its frozen record");
    }
    return { source_interpretation_id: descriptor.source_interpretation_id,
      source_record: { record_id: record.identity, source_id: record.source_id,
        source_version: record.source_version, content_digest: record.content_digest, workspace_id: record.workspace_id },
      occurrence: { question_id: message.question_id, session_id: message.session_id, session_index: message.session_index,
        round_index: message.round_index, message_id: message.message_id, message_index: message.message_index },
      original_outer_role: message.role };
  });
  return { contract: selection.contract, native_request: { ...request, response_schema: sourceSemanticCorrespondenceResponseJsonSchema(request) },
    task_presentation: { ...scope, approved_context_id: context.context_id, snapshot_identity: native.manifest.identity,
      original_outer_messages } };
}

export const CORRESPONDENCE_MODEL_VIEW_GUIDANCE = "\nThis input is a private Bench task-presentation envelope, not a new SOUL request. " +
  "Apply the ordinary response_schema and correspondence rules to native_request. task_presentation only explains the exact approved Q context. " +
  "Its verified outer roles/occurrences are not source endpoints, support handles or citations. Never infer authors from null author_ref, " +
  "identify participants merely by equal role labels, invent H referents, or use this metadata as source_semantic_support. " +
  "All contextual equivalence and applicable_context still require ordinary native Q/H support; unresolved meaning remains unresolved.";

/** Preparation and qualified consumers also bind the selected view to their actual snapshot.
 * Omission cannot activate a persisted experimental view, nor can selection borrow a foreign one. */
export function assertCorrespondenceModelViewSelection(itemsValue: readonly unknown[], selectionValue: CorrespondenceModelView | undefined,
  bindingValue: SnapshotBinding): void {
  const captured = structuredClone({ items: itemsValue, selection: selectionValue, binding: bindingValue });
  const selection = captured.selection === undefined ? undefined : CorrespondenceModelViewSchema.parse(captured.selection);
  for (const item of captured.items) {
    const view = typeof item === "object" && item !== null && "selected_model_view" in item ? item.selected_model_view : undefined;
    if (canonicalJson(view ?? null) !== canonicalJson(selection ?? null)) {
      throw new AlayaError("CONFLICT", "C workset model view differs from explicit chain selection");
    }
  }
  if (selection === undefined) return;
  const { native } = readScope(selection);
  if (resolve(selection.snapshot_path) !== resolve(captured.binding.snapshot_path) ||
      native.manifest.db_sha256 !== captured.binding.snapshot_sha256 || native.manifest.workspace_id !== captured.binding.workspace_id) {
    throw new AlayaError("CONFLICT", "C model view differs from the consumer snapshot binding");
  }
}

/** Protect readable artifact references even when semantic/seal admission fails. */
export function correspondenceModelViewInputPaths(item: unknown): readonly string[] {
  if (typeof item !== "object" || item === null || !("selected_model_view" in item)) return [];
  const view = item.selected_model_view;
  if (typeof view !== "object" || view === null || !("snapshot_path" in view) ||
      typeof view.snapshot_path !== "string" || view.snapshot_path.length === 0) return [];
  const path = view.snapshot_path, manifestPath = nativeSourceSnapshotManifestPath(path);
  const paths = [...sourceRecordsArtifactInputPaths(path), manifestPath];
  if ("persona_parent" in view && typeof view.persona_parent === "object" && view.persona_parent !== null &&
      "snapshot_path" in view.persona_parent && typeof view.persona_parent.snapshot_path === "string" && view.persona_parent.snapshot_path.length > 0) {
    paths.push(...sourceRecordsArtifactInputPaths(view.persona_parent.snapshot_path));
  }
  try {
    const manifest: unknown = JSON.parse(readRegularFileNoFollow(manifestPath, 1024 * 1024).toString("utf8"));
    if (typeof manifest === "object" && manifest !== null && "origin" in manifest &&
        typeof manifest.origin === "object" && manifest.origin !== null && "snapshot_path" in manifest.origin &&
        typeof manifest.origin.snapshot_path === "string" && manifest.origin.snapshot_path.length > 0) {
      const origin = manifest.origin.snapshot_path;
      paths.push(...sourceRecordsArtifactInputPaths(origin));
      const retained: unknown = JSON.parse(readRegularFileNoFollow(sourceRecordsManifestPath(origin), 1024 * 1024).toString("utf8"));
      if (typeof retained === "object" && retained !== null && "persona_successor" in retained &&
          typeof retained.persona_successor === "object" && retained.persona_successor !== null &&
          "parent_snapshot" in retained.persona_successor && typeof retained.persona_successor.parent_snapshot === "string" &&
          retained.persona_successor.parent_snapshot.length > 0) {
        paths.push(...sourceRecordsArtifactInputPaths(retained.persona_successor.parent_snapshot));
      }
    }
  } catch { /* Inventory is not semantic admission. The directly readable references remain protected. */ }
  return paths;
}
