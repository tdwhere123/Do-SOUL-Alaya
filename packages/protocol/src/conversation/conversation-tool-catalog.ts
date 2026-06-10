import type { ToolSpec } from "../tools/tool-spec.js";

export interface ConversationToolCatalog {
  getSpecs(): readonly Readonly<ToolSpec>[];
  replaceSpecs(specs: readonly Readonly<ToolSpec>[]): readonly Readonly<ToolSpec>[];
  hasToolName(toolName: string): boolean;
}
