import type { ToolSpec } from "./tool-spec.js";

export interface ConversationToolCatalog {
  getSpecs(): readonly Readonly<ToolSpec>[];
  replaceSpecs(specs: readonly Readonly<ToolSpec>[]): readonly Readonly<ToolSpec>[];
  hasToolName(toolName: string): boolean;
}
