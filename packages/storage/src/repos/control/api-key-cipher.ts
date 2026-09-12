import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteConnection } from "../../sqlite/db.js";

const APP_SALT = "do-soul-alaya:engine-binding-api-key:v1";
const CIPHER_PREFIX = "$alaya$v1$";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const DEFAULT_CIPHER_GENERATION = 1;
// ioreg / reg query have no natural deadline; a hung probe must not stall decrypt.
const PLATFORM_MACHINE_ID_PROBE_TIMEOUT_MS = 2_000;

let keyMaterialOverrideForTests: string | null = null;
let machineKeyIdPathOverrideForTests: string | null = null;
let platformMachineIdOverrideForTests: string | null | undefined = undefined;
let execFileSyncForTests: typeof execFileSync | null = null;

export function isEncryptedApiKeyAtRest(value: string): boolean {
  return value.startsWith(CIPHER_PREFIX);
}

export function encryptApiKeyAtRest(plaintext: string): string {
  if (plaintext.length === 0) {
    return "";
  }

  const generation = readCipherGeneration();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveApiKeyEncryptionKey(generation), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, ciphertext, authTag]).toString("base64url");
  return formatCiphertext(generation, payload);
}

export function decryptApiKeyAtRest(storedValue: string): string {
  if (storedValue.length === 0) {
    return "";
  }

  if (!isEncryptedApiKeyAtRest(storedValue)) {
    return storedValue;
  }

  const parsed = parseStoredCiphertext(storedValue);
  const currentGeneration = readCipherGeneration();
  if (parsed.generation !== currentGeneration) {
    throw new Error(
      `Failed to decrypt engine binding api_key ciphertext: generation ${parsed.generation} does not match current generation ${currentGeneration}; key rotation must be explicit.`
    );
  }
  if (parsed.payload.length < IV_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("Encrypted engine binding api_key payload is too short.");
  }

  const iv = parsed.payload.subarray(0, IV_BYTES);
  const authTag = parsed.payload.subarray(parsed.payload.length - AUTH_TAG_BYTES);
  const ciphertext = parsed.payload.subarray(IV_BYTES, parsed.payload.length - AUTH_TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveApiKeyEncryptionKey(parsed.generation),
      iv
    );
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new Error(
      "Failed to decrypt engine binding api_key ciphertext (machine- and user-bound; host or OS-user drift, or a database copied from another machine, prevents decryption).",
      { cause: error }
    );
  }
}

export function migrateEngineBindingApiKeysToCiphertext(connection: SqliteConnection): void {
  const rows = connection
    .prepare("SELECT binding_id, api_key FROM engine_bindings")
    .all() as ReadonlyArray<Readonly<{ readonly binding_id: string; readonly api_key: string }>>;
  const updateStatement = connection.prepare(
    "UPDATE engine_bindings SET api_key = ? WHERE binding_id = ?"
  );

  connection.transaction(() => {
    for (const row of rows) {
      if (row.api_key.length === 0 || isEncryptedApiKeyAtRest(row.api_key)) {
        continue;
      }

      updateStatement.run(encryptApiKeyAtRest(row.api_key), row.binding_id);
    }
  })();
}

export function __setApiKeyCipherKeyMaterialForTests(material: string | null): void {
  keyMaterialOverrideForTests = material;
}

export function __setMachineKeyIdPathForTests(filePath: string | null): void {
  machineKeyIdPathOverrideForTests = filePath;
}

export function __setPlatformMachineIdForTests(machineId: string | null | undefined): void {
  platformMachineIdOverrideForTests = machineId;
}

export function __setExecFileSyncForTests(executor: typeof execFileSync | null): void {
  execFileSyncForTests = executor;
}

export function rotateApiKeyCipherGeneration(): number {
  // Generation is independent of the durable id so rotation cannot happen by overwriting identity.
  const nextGeneration = readCipherGeneration() + 1;
  const filePath = resolveMachineKeyGenerationPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${nextGeneration}\n`, { encoding: "utf8", mode: 0o600 });
  return nextGeneration;
}

function deriveApiKeyEncryptionKey(generation: number): Buffer {
  const material = keyMaterialOverrideForTests ?? buildKeyMaterial(generation);
  return crypto.scryptSync(material, APP_SALT, KEY_BYTES);
}

function buildKeyMaterial(generation: number): string {
  const identity = `${readMachineId()}:${os.userInfo().username}:${APP_SALT}`;
  return generation === DEFAULT_CIPHER_GENERATION ? identity : `${identity}:g${generation}`;
}

function formatCiphertext(generation: number, payload: string): string {
  return generation === DEFAULT_CIPHER_GENERATION
    ? `${CIPHER_PREFIX}${payload}`
    : `${CIPHER_PREFIX}g${generation}$${payload}`;
}

function parseStoredCiphertext(storedValue: string): {
  readonly generation: number;
  readonly payload: Buffer;
} {
  const rest = storedValue.slice(CIPHER_PREFIX.length);
  const tagged = /^g([1-9]\d*)\$(.*)$/u.exec(rest);
  if (tagged !== null) {
    return {
      generation: Number(tagged[1]),
      payload: Buffer.from(tagged[2] ?? "", "base64url")
    };
  }
  return {
    generation: DEFAULT_CIPHER_GENERATION,
    payload: Buffer.from(rest, "base64url")
  };
}

function readMachineId(): string {
  const platformMachineId = readPlatformMachineId();
  if (platformMachineId !== null) {
    return platformMachineId;
  }

  return readOrCreateDurableMachineKeyId();
}

function readPlatformMachineId(): string | null {
  if (platformMachineIdOverrideForTests !== undefined) {
    return platformMachineIdOverrideForTests;
  }

  if (process.platform === "linux") {
    return readLinuxMachineId();
  }
  if (process.platform === "darwin") {
    return readMacosMachineId();
  }
  if (process.platform === "win32") {
    return readWindowsMachineId();
  }
  return null;
}

function readLinuxMachineId(): string | null {
  for (const filePath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      if (fs.existsSync(filePath)) {
        const machineId = fs.readFileSync(filePath, "utf8").trim();
        if (machineId.length > 0) {
          return machineId;
        }
      }
    } catch {
      // Try the next machine-id path.
    }
  }
  return null;
}

function readMacosMachineId(): string | null {
  try {
    const output = runPlatformMachineIdProbe(
      "ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"]
    );
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(output);
    const machineId = match?.[1]?.trim();
    return machineId !== undefined && machineId.length > 0 ? machineId : null;
  } catch {
    return null;
  }
}

function readWindowsMachineId(): string | null {
  try {
    const output = runPlatformMachineIdProbe(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]
    );
    const match = /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(output);
    const machineId = match?.[1]?.trim();
    return machineId !== undefined && machineId.length > 0 ? machineId : null;
  } catch {
    return null;
  }
}

function runPlatformMachineIdProbe(file: string, args: readonly string[]): string {
  const executor = execFileSyncForTests ?? execFileSync;
  return executor(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PLATFORM_MACHINE_ID_PROBE_TIMEOUT_MS
  });
}

function readOrCreateDurableMachineKeyId(): string {
  const filePath = resolveMachineKeyIdPath();
  if (fs.existsSync(filePath)) {
    return readExistingDurableMachineKeyId(filePath);
  }
  return createDurableMachineKeyId(filePath);
}

function readExistingDurableMachineKeyId(filePath: string): string {
  // A read error here used to mint a new UUID and brick existing $alaya$v1$ ciphertext.
  let existing: string;
  try {
    existing = fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    throw new Error(
      `Failed to read existing Alaya machine-key-id at ${filePath}; refusing to mint a replacement key.`,
      { cause: error }
    );
  }
  if (existing.length > 0) {
    return existing;
  }
  return createDurableMachineKeyId(filePath, "w");
}

function createDurableMachineKeyId(filePath: string, flag: "wx" | "w" = "wx"): string {
  const machineId = crypto.randomUUID();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filePath, `${machineId}\n`, { encoding: "utf8", mode: 0o600, flag });
    return machineId;
  } catch (error) {
    if (flag === "wx" && isAlreadyExistsError(error)) {
      return readExistingDurableMachineKeyId(filePath);
    }
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function readCipherGeneration(): number {
  const filePath = resolveMachineKeyGenerationPath();
  if (!fs.existsSync(filePath)) {
    return DEFAULT_CIPHER_GENERATION;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    throw new Error(
      `Failed to read existing Alaya machine-key generation at ${filePath}; refusing to reset cipher generation.`,
      { cause: error }
    );
  }
  const generation = Number(raw);
  if (!Number.isInteger(generation) || generation < DEFAULT_CIPHER_GENERATION) {
    throw new Error(
      `Alaya machine-key generation at ${filePath} is invalid; refusing to mint a replacement generation.`
    );
  }
  return generation;
}

function resolveMachineKeyIdPath(): string {
  if (machineKeyIdPathOverrideForTests !== null) {
    return machineKeyIdPathOverrideForTests;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const configDir =
      appData !== undefined && appData.length > 0
        ? path.join(appData, "alaya")
        : path.join(os.homedir(), "AppData", "Roaming", "alaya");
    return path.join(configDir, "machine-key-id");
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const configDir =
    xdgConfigHome !== undefined && xdgConfigHome.length > 0
      ? path.join(xdgConfigHome, "alaya")
      : path.join(os.homedir(), ".config", "alaya");
  return path.join(configDir, "machine-key-id");
}

function resolveMachineKeyGenerationPath(): string {
  return path.join(path.dirname(resolveMachineKeyIdPath()), "machine-key-generation");
}

