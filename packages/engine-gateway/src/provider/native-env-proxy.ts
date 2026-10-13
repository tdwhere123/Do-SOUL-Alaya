/** Node's command-line boolean overrides NODE_OPTIONS, which overrides the env default. */
export function resolveNativeEnvProxyEnabled(input: {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly execArgv: readonly string[];
}): boolean | undefined {
  return lastProxySwitch(input.execArgv)
    ?? lastProxySwitch(nodeOptionsArguments(input.env.NODE_OPTIONS ?? ""))
    ?? (input.env.NODE_USE_ENV_PROXY === "1" ? true : undefined);
}

function lastProxySwitch(args: readonly string[]): boolean | undefined {
  let value: boolean | undefined;
  for (const argument of args) {
    const flag = argument.replaceAll("_", "-");
    if (flag === "--use-env-proxy") value = true;
    if (flag === "--no-use-env-proxy") value = false;
  }
  return value;
}

// NODE_OPTIONS uses double quotes and backslash escapes inside quoted arguments,
// rather than shell expansion. Invalid quoting would already fail Node startup.
function nodeOptionsArguments(text: string): readonly string[] {
  const args: string[] = [];
  let quoted = false, argument = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\\" && quoted) { argument += text[++index] ?? ""; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === " " && !quoted) {
      if (argument !== "") { args.push(argument); argument = ""; }
    } else argument += character;
  }
  if (argument !== "") args.push(argument);
  return args;
}
