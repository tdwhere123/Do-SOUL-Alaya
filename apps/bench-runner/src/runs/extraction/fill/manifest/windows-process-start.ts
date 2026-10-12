import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";

const WINDOWS_PROCESS_START_TIMEOUT_MS = 20_000;
const UNIX_EPOCH_TICKS = 621355968000000000n;
const CREATION_DATE =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/u;

// cscript //B discards WScript.Echo, so the date and the absent token use StdOut.WriteLine.
const WINDOWS_PROCESS_START_SCRIPT = [
  "var pid = WScript.Arguments(0);",
  "if (!/^\\d+$/.test(String(pid))) {",
  "  WScript.StdErr.WriteLine('invalid process id');",
  "  WScript.Quit(1);",
  "}",
  "try {",
  "  var locator = new ActiveXObject('WbemScripting.SWbemLocator');",
  "  var service = locator.ConnectServer('.', 'root\\\\cimv2');",
  "  var processes = service.ExecQuery(",
  "    'SELECT CreationDate FROM Win32_Process WHERE ProcessId=' + pid,",
  "    'WQL',",
  "    0",
  "  );",
  "  var matches = new Enumerator(processes);",
  "  if (matches.atEnd()) {",
  "    WScript.StdOut.WriteLine('absent');",
  "    WScript.Quit(0);",
  "  }",
  "  var created = matches.item().CreationDate;",
  "  if (created == null) {",
  "    WScript.StdErr.WriteLine('missing creation date');",
  "    WScript.Quit(1);",
  "  }",
  "  WScript.StdOut.WriteLine(String(created));",
  "} catch (error) {",
  "  var message = error && error.description ? error.description : String(error);",
  "  WScript.StdErr.WriteLine(message);",
  "  WScript.Quit(1);",
  "}"
].join("\r\n");

export function windowsCreationDateToTicks(value: string): string | undefined {
  const match = CREATION_DATE.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const sign = match[8];
  const offsetMinutes = Number(match[9]);
  if (fraction === undefined || sign === undefined ||
      hour > 23 || minute > 59 || second > 59 || offsetMinutes > 999) {
    return undefined;
  }
  const localMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(localMs)) return undefined;
  const check = new Date(localMs);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day) {
    return undefined;
  }
  const offsetMs = offsetMinutes * 60_000;
  const utcMs = sign === "+" ? localMs - offsetMs : localMs + offsetMs;
  const ticks = BigInt(utcMs) * 10_000n + BigInt(fraction) * 10n + UNIX_EPOCH_TICKS;
  return ticks < 0n ? undefined : ticks.toString();
}

export function interpretWindowsProcessStartOutput(output: string): string {
  if (output === "absent") {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  const ticks = windowsCreationDateToTicks(output);
  if (ticks === undefined) {
    throw new ExtractionCacheInvariantError("writer process start identity is unavailable");
  }
  return ticks;
}

/** A timed-out or missing host leaves liveness unknown. Absence is the reader's own token. */
export function windowsStartIdentityFailure(cause: unknown): ExtractionCacheInvariantError {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return new ExtractionCacheInvariantError(
    "writer process start identity is unavailable",
    { cause: error }
  );
}

export function windowsProcessStartCommand(pid: number): readonly [string, readonly string[]] {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "";
  const program = root.length > 0
    ? path.win32.join(root, "System32", "cscript.exe")
    : "cscript.exe";
  return [program, [
    "//B",
    "//nologo",
    "//E:jscript",
    windowsProcessStartScriptPath(),
    String(pid)
  ]];
}

export function readWindowsProcessStartIdentity(
  pid: number,
  env: NodeJS.ProcessEnv
): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  try {
    const [program, args] = windowsProcessStartCommand(pid);
    const output = execFileSync(program, [...args], {
      encoding: "buffer",
      timeout: WINDOWS_PROCESS_START_TIMEOUT_MS,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return interpretWindowsProcessStartOutput(decodeWindowsChildOutput(output));
  } catch (cause) {
    if (cause instanceof ExtractionCacheInvariantError) throw cause;
    throw windowsStartIdentityFailure(cause);
  }
}

function windowsProcessStartScriptPath(): string {
  const digest = createHash("sha256").update(WINDOWS_PROCESS_START_SCRIPT).digest("hex").slice(0, 16);
  const filename = path.join(tmpdir(), `alaya-process-start-${digest}.js`);
  try {
    writeFileSync(filename, WINDOWS_PROCESS_START_SCRIPT, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if (!hasErrorCode(cause, "EEXIST")) throw cause;
  }
  return filename;
}

function decodeWindowsChildOutput(output: Buffer): string {
  const hasBom = output.length >= 2 && output[0] === 0xff && output[1] === 0xfe;
  const looksUtf16 = hasBom || (output.length >= 4 && output[1] === 0 && output[3] === 0);
  const text = looksUtf16
    ? output.subarray(hasBom ? 2 : 0).toString("utf16le")
    : output.toString("utf8");
  return text.replace(/^\uFEFF/u, "").replaceAll("\0", "").trim();
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null &&
    "code" in cause && cause.code === code;
}
