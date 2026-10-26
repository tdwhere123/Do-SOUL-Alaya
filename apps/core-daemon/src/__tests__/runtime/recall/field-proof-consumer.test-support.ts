import type { ConditionalFieldExecutionReceipt } from "@do-soul/alaya-core";
import type { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";

type Port = NonNullable<Parameters<typeof createMcpMemoryToolHandler>[0]["sourceSemanticsPort"]>;

/** Capture the private worker request witness before the MCP adapter strips it.
 * Public query ids and preview lengths are not trusted request/body authorities. */
export function captureFieldProofRequests(port: Port | undefined) {
  if (port === undefined) throw new Error("worker source semantics port required");
  const receipts = new Map<string, ConditionalFieldExecutionReceipt>();
  return {
    port: { ...port, execute: async (...args: Parameters<Port["execute"]>) => {
      const result = await port.execute(...args);
      if (result.kind === "recall" && result.protocol_version === 12) {
        const receipt = result.field_execution_receipt as ConditionalFieldExecutionReceipt | undefined;
        if (receipt?.compile_input?.source !== "ordinary") throw new Error("worker compile witness required");
        receipts.set(result.delivery_id, receipt);
      }
      return result;
    } },
    trust: (deliveryId: string | undefined, stored: { content_bytes: string } | null) => {
      if (deliveryId === undefined) throw new Error("delivered identity required");
      const receipt = receipts.get(deliveryId);
      if (receipt === undefined || stored === null) throw new Error("trusted request and stored body required");
      return { compile_input: receipt.compile_input, source_body_bytes: Buffer.byteLength(stored.content_bytes, "utf8") };
    }
  };
}
