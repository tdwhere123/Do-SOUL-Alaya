import {
  createAlayaOperationsService,
  type AlayaOperationsService
} from "./operations-service.js";
import {
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths
} from "./config-files.js";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";

export interface OperationsCommandDependencies {
  readonly serviceFactory?: (ctx: AlayaCliContext) => AlayaOperationsService;
}

interface OperationArgs {
  readonly outputPath: string | null;
  readonly bundlePath: string | null;
  readonly preview: boolean;
  readonly yes: boolean;
}

export function createOperationCommandSpecs(
  deps: OperationsCommandDependencies = {}
): readonly AlayaSubcommandSpec<OperationArgs>[] {
  return [
    createArtifactCommand("backup", deps),
    createArtifactCommand("export", deps),
    createImportCommand(deps)
  ];
}

function createArtifactCommand(
  name: "backup" | "export",
  deps: OperationsCommandDependencies
): AlayaSubcommandSpec<OperationArgs> {
  return {
    name,
    description: `${name} Alaya config and storage into a portable JSON bundle.`,
    argsSchema: operationArgsSchema(name),
    requiresDaemonReady: false,
    handler: async (ctx, args) => {
      const service = resolveService(ctx, deps);
      const result =
        name === "backup"
          ? await service.backup({ outputPath: args.outputPath })
          : await service.exportBundle({ outputPath: args.outputPath });
      if (ctx.jsonRequested !== true) {
        ctx.stdout.write(`${name} written: ${result.artifact_path}\n`);
      }
      return { exitCode: ALAYA_SYSEXITS.OK, json: result };
    }
  };
}

function createImportCommand(deps: OperationsCommandDependencies): AlayaSubcommandSpec<OperationArgs> {
  return {
    name: "import",
    description: "Preview or restore an Alaya backup/export bundle.",
    argsSchema: operationArgsSchema("import"),
    requiresDaemonReady: false,
    handler: async (ctx, args) => {
      if (args.bundlePath === null) {
        ctx.stderr.write("import requires a bundle path\n");
        return { exitCode: ALAYA_SYSEXITS.USAGE };
      }
      const service = resolveService(ctx, deps);
      if (args.preview) {
        const preview = await service.previewImport({ bundlePath: args.bundlePath });
        if (ctx.jsonRequested !== true) {
          ctx.stdout.write(`${JSON.stringify(preview)}\n`);
        }
        return { exitCode: ALAYA_SYSEXITS.OK, json: preview };
      }
      if (!args.yes) {
        ctx.stderr.write("import requires --yes after preview\n");
        return { exitCode: ALAYA_SYSEXITS.USAGE };
      }
      const result = await service.importBundle({ bundlePath: args.bundlePath });
      if (ctx.jsonRequested !== true) {
        ctx.stdout.write(`import restored: ${result.restored_paths.join(", ")}\n`);
      }
      return { exitCode: ALAYA_SYSEXITS.OK, json: result };
    }
  };
}

function resolveService(
  ctx: AlayaCliContext,
  deps: OperationsCommandDependencies
): AlayaOperationsService {
  if (deps.serviceFactory !== undefined) {
    return deps.serviceFactory(ctx);
  }
  return createAlayaOperationsService({
    configPaths: resolveAlayaConfigPaths(resolveAlayaConfigDir({ env: ctx.env }))
  });
}

function operationArgsSchema(command: "backup" | "export" | "import"): AlayaCliArgsSchema<OperationArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        };
      }

      const parsed = parseOperationArgs(command, input);
      if (!parsed.ok) {
        return { success: false, error: { issues: [{ path: [], message: parsed.message }] } };
      }
      return { success: true, data: parsed.args };
    }
  };
}

function parseOperationArgs(
  command: "backup" | "export" | "import",
  input: readonly string[]
): Readonly<{ ok: true; args: OperationArgs }> | Readonly<{ ok: false; message: string }> {
  let outputPath: string | null = null;
  let preview = false;
  let yes = false;
  const positionals: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === "--output") {
      const value = input[index + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: "--output requires a path." };
      }
      outputPath = value;
      index += 1;
      continue;
    }
    if (token === "--preview") {
      preview = true;
      continue;
    }
    if (token === "--yes") {
      yes = true;
      continue;
    }
    if (token.startsWith("--")) {
      return { ok: false, message: `unknown option: ${token}` };
    }
    positionals.push(token);
  }

  if (command === "import") {
    const bundlePath = positionals[0];
    // Guard instead of `positionals[0]!`: a null/undefined here means no bundle path.
    if (positionals.length !== 1 || bundlePath === undefined) {
      return { ok: false, message: "import requires exactly one bundle path." };
    }
    return {
      ok: true,
      args: { outputPath: null, bundlePath, preview, yes }
    };
  }

  if (positionals.length > 0 || preview || yes) {
    return { ok: false, message: `${command} accepts only --output <path>.` };
  }
  return {
    ok: true,
    args: { outputPath, bundlePath: null, preview: false, yes: false }
  };
}
