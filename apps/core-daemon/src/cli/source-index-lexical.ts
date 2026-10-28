import { BoundedIdSchema, SourceIndexLexicalRepresentationSchema, type SourceIndexLexicalRepresentation } from "@do-soul/alaya-protocol";
import type { AlayaDaemonRuntime } from "../runtime/daemon/lifecycle/daemon-runtime-types.js";
import { ALAYA_SYSEXITS, type AlayaCliArgsSchema, type AlayaSubcommandSpec } from "./bridge.js";

interface LexicalSelectionArgs {
  readonly workspaceId: string;
  readonly representation: SourceIndexLexicalRepresentation;
}

export function createSourceIndexLexicalCommand(
  runtime: Pick<AlayaDaemonRuntime, "runSourceIndexLexicalPass">
): AlayaSubcommandSpec<LexicalSelectionArgs> {
  return {
    name: "source-index-lexical",
    description: "Select a workspace lexical representation and run one bounded preparation pass.",
    argsSchema: lexicalSelectionArgsSchema(),
    requiresDaemonReady: true,
    handler: async (context, args) => {
      if (runtime.runSourceIndexLexicalPass === undefined) {
        context.stderr.write("SourceIndex lexical preparation is unavailable in this runtime.\n");
        return { exitCode: ALAYA_SYSEXITS.TEMPFAIL, json: { status: "unavailable", reason: "producer_not_wired" } };
      }
      const result = await runtime.runSourceIndexLexicalPass(args.workspaceId, args.representation);
      if (context.jsonRequested !== true) {
        context.stdout.write(`workspace=${result.selection.workspace_id} representation=${result.selection.representation}` +
          ` selection_revision=${result.selection.selection_revision} status=${result.status}` +
          ` generation=${result.generation?.generation_id ?? "none"} reason=${result.reason ?? "none"}\n`);
      }
      return { exitCode: result.status === "ready" ? ALAYA_SYSEXITS.OK : ALAYA_SYSEXITS.TEMPFAIL,
        json: { action: "select", ...result } };
    }
  };
}

function lexicalSelectionArgsSchema(): AlayaCliArgsSchema<LexicalSelectionArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some(token => typeof token !== "string") || input[0] !== "select") {
        return invalidArgs("Usage: source-index-lexical select --workspace <id> --representation <representation>");
      }
      const options = new Map<string, string>();
      for (let offset = 1; offset < input.length; offset += 2) {
        const option = input[offset];
        const value = input[offset + 1];
        if (option !== "--workspace" && option !== "--representation") return invalidArgs(`Unknown option: ${String(option)}`);
        if (options.has(option)) return invalidArgs(`Duplicate option: ${option}`);
        if (typeof value !== "string" || value.startsWith("--")) return invalidArgs(`${option} requires a value.`);
        options.set(option, value);
      }
      const workspace = BoundedIdSchema.safeParse(options.get("--workspace"));
      const representation = SourceIndexLexicalRepresentationSchema.safeParse(options.get("--representation"));
      if (!workspace.success) return invalidArgs("--workspace requires a valid workspace id.");
      if (!representation.success) return invalidArgs(`--representation must be ${SourceIndexLexicalRepresentationSchema.options.join(", ")}.`);
      return { success: true, data: { workspaceId: workspace.data, representation: representation.data } };
    }
  };
}

function invalidArgs(message: string): ReturnType<AlayaCliArgsSchema<LexicalSelectionArgs>["safeParse"]> {
  return { success: false, error: { issues: [{ path: [], message }] } };
}
