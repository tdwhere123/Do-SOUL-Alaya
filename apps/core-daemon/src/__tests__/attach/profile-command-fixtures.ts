import { PassThrough } from "node:stream";
import type { AlayaCliContext } from "../../cli/bridge.js";
import type {
  ProfileMutationAuditRow,
  ProfileMutationAuditWriter,
  ProfileMutationFs
} from "../../attach/profile-mutation.js";

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
  env: NodeJS.ProcessEnv = { HOME: "/tmp/home" }
): AlayaCliContext {
  return {
    cwd: "/tmp",
    env,
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] }
  };
}
