import { PassThrough } from "node:stream";
import type { AlayaCliContext } from "../../cli/bridge.js";
import type {
  ProfileMutationAuditRow,
  ProfileMutationAuditWriter,
  ProfileMutationFs
} from "../../attach/profile-mutation.js";
import { createProfileTestEnv } from "../support/profile-test-home.js";
import path from "node:path";
import os from "node:os";

export class MemoryProfileFs implements ProfileMutationFs {
  public readonly files = new Map<string, string>();

  public async readText(filePath: string): Promise<string | undefined> {
    return this.files.get(filePath);
  }

  public async writeTextAtomic(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  public async removeText(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

export class MemoryProfileAuditWriter implements ProfileMutationAuditWriter {
  public readonly rows: ProfileMutationAuditRow[] = [];

  public async append(row: ProfileMutationAuditRow): Promise<void> {
    this.rows.push(row);
  }

  public async rollback(row: ProfileMutationAuditRow): Promise<void> {
    this.rows.splice(this.rows.indexOf(row), 1);
  }
}

export function createProfileCommandContext(
  env: NodeJS.ProcessEnv = createProfileTestEnv()
): AlayaCliContext {
  return {
    cwd: path.join(os.tmpdir(), "alaya-profile-cwd"),
    env,
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] }
  };
}
