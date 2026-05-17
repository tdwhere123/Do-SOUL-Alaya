import { z } from "zod";

// invariant: closed set of GovernancePolicy outcomes the agent applies
// when classifying a staged warning. Shared between the resolve verb
// request (agent-supplied) and the resolution audit event payload
// (daemon-echoed). Lives outside both modules to keep the resolve
// request <-> event payload edge acyclic.
// see also: packages/core/src/governance-policy.ts
// see also: packages/protocol/src/events/governance-resolution.ts
// see also: packages/protocol/src/soul/resolution.ts
export const GovernanceResolutionPolicyClassificationSchema = z.enum([
  "ask_now",
  "apply_silently",
  "track_only",
  "inspect_later"
]);

export type GovernanceResolutionPolicyClassification = z.infer<
  typeof GovernanceResolutionPolicyClassificationSchema
>;
