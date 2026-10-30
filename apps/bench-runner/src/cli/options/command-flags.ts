import { AlayaError } from "@do-soul/alaya-protocol";
import { parseFlags, type ParsedFlags } from "../cli-options.js";

/** Validate command-owned tokens before forwarding the remainder to the strict common parser. */
export function parseFlagsWithoutCommandOptions(
  args: readonly string[], values: readonly string[], booleans: readonly string[] = []
): ParsedFlags {
  const common: string[] = [], seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!, flag = token.split("=", 1)[0]!;
    if (booleans.includes(token) || values.includes(flag)) {
      if (seen.has(flag)) throw new AlayaError("VALIDATION", `${flag} may be provided only once`);
      seen.add(flag);
      if (booleans.includes(token)) continue;
      const value = token.includes("=") ? token.slice(flag.length + 1) : args[++index];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new AlayaError("VALIDATION", `${flag} requires a value`);
      }
    } else common.push(token);
  }
  return parseFlags(common);
}
