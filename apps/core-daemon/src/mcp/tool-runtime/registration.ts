import { CoreError, type ToolSpecService } from "@do-soul/alaya-core";
import type { ToolSpec } from "@do-soul/alaya-protocol";

type ConversationToolSpecService = Pick<ToolSpecService, "findById" | "register" | "update">;

export async function registerConversationToolSpecs(
  service: ConversationToolSpecService,
  specs: readonly Readonly<ToolSpec>[]
): Promise<void> {
  const uniqueSpecs = dedupeToolSpecs(specs);
  const writePlans = await Promise.all(
    uniqueSpecs.map(async (spec) => {
      try {
        const existing = await service.findById(spec.tool_id);
        if (toolSpecsAreEqual(existing, spec)) {
          return { spec, writeKind: "skip" as const };
        }
        return { spec, writeKind: "update" as const };
      } catch (error) {
        if (error instanceof CoreError && error.code === "NOT_FOUND") {
          return { spec, writeKind: "register" as const };
        }
        throw error;
      }
    })
  );

  await Promise.all(
    writePlans.map(async (plan) => {
      if (plan.writeKind === "skip") return;
      if (plan.writeKind === "register") {
        await service.register(plan.spec);
        return;
      }
      await service.update(plan.spec);
    })
  );
}

function toolSpecsAreEqual(left: Readonly<ToolSpec>, right: Readonly<ToolSpec>): boolean {
  return (
    left.tool_id === right.tool_id &&
    left.category === right.category &&
    left.description === right.description &&
    left.scope_guard === right.scope_guard &&
    left.read_only === right.read_only &&
    left.destructive === right.destructive &&
    left.concurrency_safe === right.concurrency_safe &&
    left.interrupt_behavior === right.interrupt_behavior &&
    left.requires_confirmation === right.requires_confirmation &&
    left.requires_evidence_reopen === right.requires_evidence_reopen &&
    left.rollback_support === right.rollback_support &&
    left.fast_path_eligible === right.fast_path_eligible
  );
}

function dedupeToolSpecs(specs: readonly Readonly<ToolSpec>[]): readonly Readonly<ToolSpec>[] {
  const byId = new Map<string, Readonly<ToolSpec>>();
  for (const spec of specs) byId.set(spec.tool_id, spec);
  return [...byId.values()];
}
