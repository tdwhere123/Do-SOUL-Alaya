import { deepFreeze } from "../shared/deep-freeze.js";
import type { SkillPackage, ToolProvider } from "./extension-descriptors.js";
import { SkillPackageSchema, ToolProviderSchema } from "./extension-descriptors.js";

export function parseExtensionToolProvider(value: unknown): Readonly<ToolProvider> {
  return deepFreeze(ToolProviderSchema.parse(value));
}

export function parseExtensionSkillPackage(value: unknown): Readonly<SkillPackage> {
  return deepFreeze(SkillPackageSchema.parse(value));
}
