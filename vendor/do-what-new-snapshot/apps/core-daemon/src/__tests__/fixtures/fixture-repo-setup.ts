import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FixtureRepo {
  readonly repoPath: string;
  cleanup(): Promise<void>;
  write(relPath: string, content: string | Uint8Array): Promise<void>;
  remove(relPath: string): Promise<void>;
  link(relPath: string, target: string): Promise<void>;
  commitAll(message: string): Promise<string>;
  runGit(args: readonly string[]): Promise<string>;
  resolve(relPath: string): string;
}

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const repoPath = await mkdtemp(path.join(process.cwd(), ".tmp-c31-repo-"));

  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.name", "C31 Test"]);
  await runGit(repoPath, ["config", "user.email", "c31@example.com"]);

  return {
    repoPath,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
    },
    write: async (relPath, content) => {
      const absolutePath = path.join(repoPath, relPath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    },
    remove: async (relPath) => {
      await unlink(path.join(repoPath, relPath));
    },
    link: async (relPath, target) => {
      const absolutePath = path.join(repoPath, relPath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await rm(absolutePath, { force: true });
      await symlink(target, absolutePath);
    },
    commitAll: async (message) => {
      await runGit(repoPath, ["add", "--all"]);
      await runGit(repoPath, ["commit", "-m", message]);
      return (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
    },
    runGit: async (args) => await runGit(repoPath, args),
    resolve: (relPath) => path.join(repoPath, relPath)
  };
}

async function runGit(repoPath: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd: repoPath, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(`git ${args.join(" ")} failed in ${repoPath}: ${stderr || stdout || error.message}`)
        );
        return;
      }

      resolve(stdout);
    });
  });
}
