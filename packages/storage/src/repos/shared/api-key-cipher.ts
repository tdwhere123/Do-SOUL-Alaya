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

let keyMaterialOverrideForTests: string | null = null;
let machineKeyIdPathOverrideForTests: string | null = null;
let platformMachineIdOverrideForTests: string | null | undefined = undefined;

export function isEncryptedApiKeyAtRest(value: string): boolean {
  return value.startsWith(CIPHER_PREFIX);
}

export function encryptApiKeyAtRest(plaintext: string): string {
  if (plaintext.length === 0) {
    return "";
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveApiKeyEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, ciphertext, authTag]).toString("base64url");
  return `${CIPHER_PREFIX}${payload}`;
}

export function decryptApiKeyAtRest(storedValue: string): string {
  if (storedValue.length === 0) {
    return "";
  }

  if (!isEncryptedApiKeyAtRest(storedValue)) {
    return storedValue;
  }

  const payload = Buffer.from(storedValue.slice(CIPHER_PREFIX.length), "base64url");
  if (payload.length < IV_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("Encrypted engine binding api_key payload is too short.");
  }

  const iv = payload.subarray(0, IV_BYTES);
  const authTag = payload.subarray(payload.length - AUTH_TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES, payload.length - AUTH_TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveApiKeyEncryptionKey(), iv);
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

function deriveApiKeyEncryptionKey(): Buffer {
  const material = keyMaterialOverrideForTests ?? buildKeyMaterial();
  return crypto.scryptSync(material, APP_SALT, KEY_BYTES);
}

function buildKeyMaterial(): string {
  return `${readMachineId()}:${os.userInfo().username}:${APP_SALT}`;
}

function readMachineId(): string {
  const platformMachineId = readPlatformMachineId();
  if (platformMachineId !== null) {
    return platformMachineId;
  }

  if (keyMaterialOverrideForTests !== null || isCipherTestRuntime()) {
    // Test-only fallback: hostname is weaker than machine-id. Production must
    // never run with NODE_ENV=test or VITEST=true — those gates exist solely
    // so unit tests can derive keys without platform ids; a production process
    // without platform ids falls through to the durable machine-key-id file.
    return os.hostname();
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
    const output = execFileSync(
      "ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
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
    const output = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const match = /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(output);
    const machineId = match?.[1]?.trim();
    return machineId !== undefined && machineId.length > 0 ? machineId : null;
  } catch {
    return null;
  }
}

function readOrCreateDurableMachineKeyId(): string {
  const filePath = resolveMachineKeyIdPath();
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf8").trim();
      if (existing.length > 0) {
        return existing;
      }
    }
  } catch {
    // Fall through to create a new durable id.
  }

  const machineId = crypto.randomUUID();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${machineId}\n`, { encoding: "utf8", mode: 0o600 });
  return machineId;
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

function isCipherTestRuntime(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}
