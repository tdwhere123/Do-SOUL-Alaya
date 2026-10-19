import { z } from "zod";
import { AlayaError, canonicalJson, SoulInterpretationResponseSchema, sourceSemanticAccessPhases,
  type SoulInterpretationResponse } from "@do-soul/alaya-protocol";
import type { SemanticChainConfig } from "./contract.js";

const Response: z.ZodType<SoulInterpretationResponse> = SoulInterpretationResponseSchema;
export const SemanticChainSourceFailureSchema = z.object({
  kind: z.enum(["unavailable", "mismatch"]), reason: z.string(), response: Response
}).strict();
export type SemanticChainSourceFailure = z.infer<typeof SemanticChainSourceFailureSchema>;

/** The actual failed observation survives both preparation and replay; unknown is not a mismatch. */
export class SemanticChainSourceObservationError extends AlayaError {
  constructor(public readonly failure: SemanticChainSourceFailure) {
    super("UNAVAILABLE", `native Source ${failure.kind}: ${failure.reason}`);
  }
}

/** Admission of the enabled execution, not a second acquisition or ranking policy. */
export function assertSemanticChainSourceObservation(config: SemanticChainConfig,
  response: Extract<SoulInterpretationResponse, { operation: "prepare_query" }>): void {
  if (config.source_index === undefined) return;
  const fail = (kind: SemanticChainSourceFailure["kind"], reason: string): never => {
    throw new SemanticChainSourceObservationError({ kind, reason, response });
  };
  if (response.access === undefined) return fail("unavailable", response.outcome?.status ?? "access_receipt_missing");
  const phases = sourceSemanticAccessPhases(response.access);
  const selected = phases.preparation.selected, expected = config.source_index.index;
  if (selected !== null && (selected.profile_id !== expected.profile_id || selected.config_id !== expected.config_id ||
      selected.selection_revision !== expected.selection_revision ||
      canonicalJson(selected.profile) !== canonicalJson(expected.configuration.profile))) fail("mismatch", "selected_profile_changed");
  const acquired = phases.acquisition.result, state = acquired?.vector.state;
  if (state != null && "binding" in state && (state.binding.workspace_id !== config.workspace_id ||
      state.binding.generation_id !== expected.generation_id || state.binding.source_epoch !== expected.source_epoch ||
      state.binding.profile_id !== expected.profile_id || state.binding.config_id !== expected.config_id ||
      state.binding.selection_revision !== expected.selection_revision ||
      state.binding.dimensions !== expected.configuration.profile.dimensions)) fail("mismatch", "active_generation_changed");
  if (phases.preparation.status !== "ready" || selected === null) {
    fail("unavailable", phases.preparation.reason ?? "query_preparation_not_ready");
  }
  if (phases.preparation.method !== "local_inference" || phases.preparation.submitted_inputs !== 1 ||
      phases.preparation.external_api_attempts !== 0) fail("unavailable", "local_preparation_not_established");
  if (phases.acquisition.status !== "executed" || acquired == null) {
    return fail("unavailable", phases.acquisition.reason ?? "acquisition_not_executed");
  }
  if (state == null || !("binding" in state)) return fail("unavailable", state?.reason ?? "active_binding_missing");
  if (state.status !== "ready" && state.status !== "valid_empty") return fail("unavailable", `active_generation_${state.status}`);
  if (acquired.vector.input.status !== "available") return fail("unavailable", acquired.vector.input.reason);
  if (acquired.vector.input.profile_id !== expected.profile_id) return fail("mismatch", "query_vector_profile_changed");
  // Generation ready and phase accounting complete are not a finished query scan.
  // Only a complete vector scan or the producer window_limit prefix may admit; other partials and native_unknown stay unavailable.
  if ((acquired.vector.completion !== "complete" &&
      (acquired.vector.completion !== "partial" || acquired.vector.reason !== "window_limit")) ||
      acquired.accounting.native_unknown !== 0 || acquired.vector.validation !== "validated" ||
      acquired.vector.invalid_windows > 0 || acquired.resource_refusals.length > 0 ||
      phases.acquisition.accounting !== "complete") fail("unavailable", acquired.vector.reason ?? "acquisition_incomplete");
}
