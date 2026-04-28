import { PromptAssetSchema, type ConstitutionalFragment, type PromptAsset } from "@do-what/protocol";
import { PromptAssetRegistry } from "../prompt-asset-registry.js";
import {
  WORKER_IDENTITY_FRAGMENT,
  buildRegisteredConstitutionalPromptAssetAliases,
  buildRegisteredConstitutionalPromptAssets,
  buildSafetyConstitutionalFragment
} from "./constitutional-fragments.js";

export { WORKER_IDENTITY_FRAGMENT };

export interface WorkerDispatchPromptAssemblyInput {
  readonly callerPrompt: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly principalSecuritySnapshot: {
    readonly governance_lease_ref: string;
    readonly hard_constraint_refs: readonly string[];
    readonly denied_tool_categories: readonly string[];
  };
  readonly serverTruthHardConstraints?: readonly {
    readonly ref: string;
    readonly resolved_ref?: string;
    readonly content: string;
  }[];
}

export interface WorkerDispatchPromptAssemblyResult {
  readonly prompt: string;
  readonly resolvedHardConstraintRefs: readonly string[];
  readonly constitutionalAssetsBound: boolean;
}

export interface WorkerDispatchPromptAssemblerDependencies {
  readonly promptAssetRegistry: Pick<PromptAssetRegistry, "list" | "getById">;
  readonly constitutionalFragmentReader?: {
    listForWorkspace(workspaceId: string): Promise<readonly Readonly<ConstitutionalFragment>[]>;
  };
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export class WorkerDispatchPromptAssembler {
  public constructor(private readonly deps: WorkerDispatchPromptAssemblerDependencies) {}

  public async assemble(input: WorkerDispatchPromptAssemblyInput): Promise<string> {
    return (await this.assembleWithMetadata(input)).prompt;
  }

  public async assembleWithMetadata(
    input: WorkerDispatchPromptAssemblyInput
  ): Promise<Readonly<WorkerDispatchPromptAssemblyResult>> {
    const assemblyRegistry = new PromptAssetRegistry();
    const baseAssets = this.deps.promptAssetRegistry.list();
    const workspaceFragments =
      (await this.deps.constitutionalFragmentReader?.listForWorkspace(input.workspaceId)) ?? [];
    const registeredFragmentAliases =
      buildRegisteredConstitutionalPromptAssetAliases(workspaceFragments);
    const serverTruthConstraintMap = createServerTruthConstraintMap(input.serverTruthHardConstraints);
    let resolvedHardConstraintRefs: readonly string[] = [];

    for (const asset of baseAssets) {
      if (asset.kind === "constitutional") {
        assemblyRegistry.register(
          PromptAssetSchema.parse({
            ...asset,
            content: sanitizeConstitutionalContent(asset.content)
          })
        );
      } else {
        assemblyRegistry.register(asset);
      }
    }

    for (const asset of buildRegisteredConstitutionalPromptAssets(workspaceFragments)) {
      assemblyRegistry.register(
        PromptAssetSchema.parse({
          ...asset,
          content: sanitizeConstitutionalContent(asset.content)
        })
      );
    }

    if (this.deps.promptAssetRegistry.getById(WORKER_IDENTITY_FRAGMENT.asset_id) === null) {
      assemblyRegistry.register(WORKER_IDENTITY_FRAGMENT);
    }

    const safetyFragment = createRunScopedSafetyFragment({
      workspaceId: input.workspaceId,
      runId: input.runId,
      deniedToolCategories: input.principalSecuritySnapshot.denied_tool_categories,
      hardConstraintRefs: input.principalSecuritySnapshot.hard_constraint_refs,
      resolveHardConstraintRef: (constraintRef) =>
        resolveHardConstraintRef(
          constraintRef,
          serverTruthConstraintMap,
          assemblyRegistry,
          registeredFragmentAliases
        ),
      onResolvedHardConstraintRefs: (resolvedRefs) => {
        resolvedHardConstraintRefs = resolvedRefs;
      },
      warn: (message, meta) =>
        this.deps.warn?.(message, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          ...meta
        })
    });
    assemblyRegistry.register(safetyFragment);
    assemblyRegistry.register(
      createWorkerTaskAsset({
        workspaceId: input.workspaceId,
        runId: input.runId,
        governanceLeaseRef: input.principalSecuritySnapshot.governance_lease_ref,
        callerPrompt: input.callerPrompt
      })
    );

    return Object.freeze({
      prompt: assemblyRegistry.assemble(),
      resolvedHardConstraintRefs: Object.freeze([...resolvedHardConstraintRefs]),
      constitutionalAssetsBound: assemblyRegistry.getConstitutional().length > 0
    });
  }
}

function sanitizeConstitutionalContent(content: string): string {
  return content
    .replace(/```([^`]+)```/g, "\"$1\"")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createRunScopedSafetyFragment(params: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly deniedToolCategories: readonly string[];
  readonly hardConstraintRefs: readonly string[];
  readonly resolveHardConstraintRef: (constraintRef: string) => Readonly<PromptAsset> | null;
  readonly onResolvedHardConstraintRefs: (resolvedRefs: readonly string[]) => void;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}) {
  const fragment = buildSafetyConstitutionalFragment({
    deniedToolCategories: params.deniedToolCategories,
    hardConstraintRefs: params.hardConstraintRefs,
    resolveHardConstraintRef: params.resolveHardConstraintRef,
    onResolvedHardConstraintRefs: params.onResolvedHardConstraintRefs,
    warn: params.warn
  });

  return PromptAssetSchema.parse({
    ...fragment,
    asset_id: `constitutional:worker-baseline-safety:${params.workspaceId}:${params.runId}`
  });
}

function createWorkerTaskAsset(params: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly governanceLeaseRef: string;
  readonly callerPrompt: string;
}) {
  return PromptAssetSchema.parse({
    asset_id: `operational:worker-task:${params.workspaceId}:${params.runId}`,
    kind: "operational",
    label: "Worker Task",
    content: [
      `Governance lease ref: ${JSON.stringify(params.governanceLeaseRef)}`,
      "Complete the delegated task while honoring all constitutional constraints.",
      "",
      params.callerPrompt
    ].join("\n"),
    priority: 10,
    immutable: false
  });
}

function createServerTruthConstraintMap(
  serverTruthHardConstraints: WorkerDispatchPromptAssemblyInput["serverTruthHardConstraints"]
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();

  for (const item of serverTruthHardConstraints ?? []) {
    const ref = item.ref.trim();
    const resolvedRef = (item.resolved_ref ?? item.ref).trim();
    const content = item.content.trim();

    if (ref.length === 0 || resolvedRef.length === 0 || content.length === 0) {
      continue;
    }

    entries.set(resolvedRef, content);
    if (resolvedRef !== ref) {
      entries.set(ref, content);
    }
  }

  return entries;
}

function resolveHardConstraintRef(
  constraintRef: string,
  serverTruthConstraintMap: ReadonlyMap<string, string>,
  promptAssetRegistry: Pick<PromptAssetRegistry, "getById">,
  registeredFragmentAliases: ReadonlyMap<string, Readonly<PromptAsset>>
): Readonly<PromptAsset> | null {
  if (serverTruthConstraintMap.size > 0) {
    const serverTruthContent = serverTruthConstraintMap.get(constraintRef);
    if (serverTruthContent === undefined) {
      return null;
    }

    return PromptAssetSchema.parse({
      asset_id: `constitutional:server-truth:${constraintRef}`,
      kind: "constitutional",
      label: `Server Truth Constraint (${constraintRef})`,
      content: serverTruthContent,
      priority: 97,
      immutable: true
    });
  }

  const aliasedFragment = registeredFragmentAliases.get(constraintRef);
  if (aliasedFragment !== undefined) {
    return aliasedFragment;
  }

  return promptAssetRegistry.getById(constraintRef);
}
