export interface LongMemEvalMatrixPromotionCommandOptions {
  readonly contractPath: string;
  readonly outputPath: string;
}

interface MutablePromotionOptions {
  contractPath?: string;
  outputPath?: string;
}

export function parseLongMemEvalMatrixPromotionCommandOptions(
  args: ReadonlyArray<string>
): LongMemEvalMatrixPromotionCommandOptions {
  const options: MutablePromotionOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--contract" || token === "--out") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      assignOption(options, token, value);
      index += 1;
      continue;
    }
    const equals = token.match(/^(--contract|--out)=(.*)$/u);
    if (equals !== null) {
      if (equals[2] === "") throw new Error(`${equals[1]} requires a value`);
      assignOption(options, equals[1] as "--contract" | "--out", equals[2]!);
      continue;
    }
    if (token.startsWith("--")) throw new Error(`unknown option '${token}'`);
    throw new Error(`unexpected argument '${token}'`);
  }
  if (options.contractPath === undefined) throw new Error("--contract <json> required");
  if (options.outputPath === undefined) throw new Error("--out <json> required");
  return { contractPath: options.contractPath, outputPath: options.outputPath };
}

function assignOption(
  options: MutablePromotionOptions,
  flag: "--contract" | "--out",
  value: string
): void {
  const key = flag === "--contract" ? "contractPath" : "outputPath";
  if (options[key] !== undefined) throw new Error(`duplicate ${flag}`);
  options[key] = value;
}
