import { CandidateMemorySignalSchema, type ConversationMessage, type ExecutionStanceModelRef, type Run, type RuntimeMode as RuntimeModeValue, type Workspace } from "@do-soul/alaya-protocol";
import {
  RuntimeMode,
  buildRecalledContextSection,
  createGardenMaterializationBatchStats,
  recordSignalResult,
  releaseGovernanceLeaseSafely,
  resolveGardenComputeProvider,
  type ConversationGardenComputeProviderPort,
  type ConversationServiceMethodOwner,
  type GardenProviderCallTelemetry,
  type MemoryContextAssemblyResult
} from "./conversation-service-internal.js";
import { conversationServiceRecordGardenProviderCallCompleted, conversationServiceRecordGardenProviderCallStarted } from "./conversation-service-methods-3.js";
import { conversationServiceRecordGardenProviderCallFailed } from "./conversation-service-methods-4.js";

export async function conversationServiceAssembleContextForTurn(owner: ConversationServiceMethodOwner, input: {
    readonly run: Run;
    readonly workspace: Workspace;
    readonly displayName?: string;
    readonly runtimeMode?: RuntimeModeValue;
  }): Promise<MemoryContextAssemblyResult> {
    if (owner.dependencies.contextLensAssembler === undefined) {
      return {
        contextLens: null,
        workingProjection: null,
        recalledContextSection: ""
      };
    }

    let runtimeMode: RuntimeModeValue = input.runtimeMode ?? RuntimeMode.FULL;
    if (input.runtimeMode === undefined && owner.dependencies.budgetBankruptcyService !== undefined) {
      try {
        const snapshot = await owner.dependencies.budgetBankruptcyService.getSnapshot(
          input.run.run_id,
          new Date().toISOString()
        );
        runtimeMode = snapshot.current_mode;
      } catch (error) {
        runtimeMode = RuntimeMode.MINIMAL;
        owner.dependencies.warn(
          "[ConversationService] Budget bankruptcy snapshot lookup failed; using minimal runtime mode",
          {
            run_id: input.run.run_id,
            workspace_id: input.workspace.workspace_id,
            error
          }
        );
      }
    }

    try {
      const assembled = await owner.dependencies.contextLensAssembler.assemble({
        run: input.run,
        surfaceId: input.run.current_surface_id ?? null,
        displayName: input.displayName,
        runtimeMode
      });

      return {
        contextLens: assembled.contextLens,
        workingProjection: assembled.workingProjection,
        recalledContextSection: buildRecalledContextSection(assembled.workingProjection)
      };
    } catch (error) {
      owner.dependencies.warn("[ConversationService] ContextLens assembly failed, proceeding without lens", {
        run_id: input.run.run_id,
        workspace_id: input.workspace.workspace_id,
        error
      });

      return {
        contextLens: null,
        workingProjection: null,
        recalledContextSection: ""
      };
    }
  }

export function conversationServiceTriggerGardenCompile(owner: ConversationServiceMethodOwner, input: {
    readonly run: Run;
    readonly workspace: Workspace;
    readonly modelRef: ExecutionStanceModelRef | null;
    readonly userMessage: ConversationMessage;
    readonly assistantMessage: ConversationMessage;
  }): void {
    const turnMessages = [input.userMessage, input.assistantMessage] as const;
    const turnContent = input.userMessage.content;

    void (async () => {
      let gardenComputeProvider: ConversationGardenComputeProviderPort | null = null;
      let providerCall: GardenProviderCallTelemetry | null = null;

      try {
        const resolvedGardenComputeProvider = await resolveGardenComputeProvider(owner, input.modelRef);
        gardenComputeProvider = resolvedGardenComputeProvider;
        providerCall = await conversationServiceRecordGardenProviderCallStarted(owner, input, resolvedGardenComputeProvider);

        const signals = await resolvedGardenComputeProvider.compile(turnContent, {
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          surface_id: input.run.current_surface_id ?? null,
          turn_messages: turnMessages
        });
        await conversationServiceRecordGardenProviderCallCompleted(owner, input, providerCall, resolvedGardenComputeProvider);
        let stats = createGardenMaterializationBatchStats();

        for (const signal of signals) {
          const parsedSignal = CandidateMemorySignalSchema.parse(signal);

          try {
            const result = await owner.dependencies.signalReceiver.receiveSignal(parsedSignal);
            stats = recordSignalResult(stats, result);
          } catch (error) {
            owner.dependencies.warn("Garden signal delivery failed.", {
              workspace_id: input.workspace.workspace_id,
              run_id: input.run.run_id,
              signal_id: parsedSignal.signal_id,
              error
            });
          }
        }

        await owner.dependencies.sessionOverridePromotion
          ?.evaluateActiveForRun({
            runId: input.run.run_id,
            workspaceId: input.workspace.workspace_id
          })
          .catch((error) => {
            owner.dependencies.warn("Session override promotion failed.", {
              workspace_id: input.workspace.workspace_id,
              run_id: input.run.run_id,
              error
            });
          });

        owner.dependencies.warn("Garden materialization batch processed.", {
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          provider_kind: resolvedGardenComputeProvider.provider_kind,
          ...stats
        });
      } catch (error) {
        if (gardenComputeProvider !== null) {
          await conversationServiceRecordGardenProviderCallFailed(owner, input, providerCall, gardenComputeProvider, error);
        }
        owner.dependencies.warn("Garden compile failed.", {
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          provider_kind: gardenComputeProvider?.provider_kind ?? "unresolved",
          error
        });
      } finally {
        await releaseGovernanceLeaseSafely(owner, input.run.run_id, input.workspace.workspace_id, "Garden work");
      }
    })();
  }
