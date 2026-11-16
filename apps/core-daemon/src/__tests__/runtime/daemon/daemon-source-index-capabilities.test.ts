import { describe, expectTypeOf, it } from "vitest";
import type {
  SourceEmbeddingRepresentation,
  SourceIndexLexicalPreparationAllocation,
  SourceIndexLexicalRepresentation,
  SourceIndexWindowing
} from "@do-soul/alaya-protocol";
import type { createDaemonLifecycleControls } from "../../../runtime/daemon/lifecycle/daemon-runtime-lifecycle.js";
import type { AlayaDaemonRuntime } from "../../../runtime/daemon/lifecycle/daemon-runtime-types.js";
import type {
  SourceIndexLexicalProducerPassReceipt,
  SourceIndexProducerPassReceipt,
  SourceIndexProducerPassRemaining
} from "../../../runtime/source-index/source-index-producer.js";

type ProducerPort = NonNullable<Parameters<typeof createDaemonLifecycleControls>[0]["sourceIndexProducer"]>;
type Controls = ReturnType<typeof createDaemonLifecycleControls>;
type VectorPass = (
  remaining?: SourceIndexProducerPassRemaining,
  representation?: SourceEmbeddingRepresentation,
  windowing?: SourceIndexWindowing
) => Promise<SourceIndexProducerPassReceipt>;
type LexicalPass = (
  workspaceId: string,
  representation: SourceIndexLexicalRepresentation,
  remaining?: SourceIndexProducerPassRemaining,
  allocation?: SourceIndexLexicalPreparationAllocation
) => Promise<SourceIndexLexicalProducerPassReceipt>;

describe("daemon source-index capability types", () => {
  it("accepts scheduling-only producers and preserves optional preparation capabilities", () => {
    expectTypeOf<{ start(): void; stop(): Promise<void> }>().toExtend<ProducerPort>();
    expectTypeOf<ProducerPort["runPass"]>().toEqualTypeOf<VectorPass | undefined>();
    expectTypeOf<ProducerPort["runLexicalPass"]>().toEqualTypeOf<LexicalPass | undefined>();
  });

  it("preserves preparation arguments and receipts through controls and the optional runtime surface", () => {
    expectTypeOf<Controls["runSourceIndexPass"]>().toEqualTypeOf<VectorPass>();
    expectTypeOf<Controls["runSourceIndexLexicalPass"]>().toEqualTypeOf<LexicalPass>();
    expectTypeOf<AlayaDaemonRuntime["runSourceIndexPass"]>().toEqualTypeOf<VectorPass | undefined>();
    expectTypeOf<AlayaDaemonRuntime["runSourceIndexLexicalPass"]>().toEqualTypeOf<LexicalPass | undefined>();
  });
});
