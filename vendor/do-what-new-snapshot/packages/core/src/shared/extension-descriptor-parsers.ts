import {
  parseExtensionSkillPackage as parseProtocolExtensionSkillPackage,
  parseExtensionToolProvider as parseProtocolExtensionToolProvider,
  type SkillPackage,
  type ToolProvider
} from "@do-what/protocol";
import { CoreError } from "../errors.js";

export function parseExtensionToolProvider(value: unknown): Readonly<ToolProvider> {
  try {
    return parseProtocolExtensionToolProvider(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid tool provider payload", { cause: error });
  }
}

export function parseExtensionSkillPackage(value: unknown): Readonly<SkillPackage> {
  try {
    return parseProtocolExtensionSkillPackage(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid skill package payload", { cause: error });
  }
}
