import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SourceAcquisitionExperimentInput } from "../../../runs/semantic-chain/source-acquisition-experiment.js";

/** A physical candidate owns its synthetic child; parallel readers keep using
 * the unchanged checkout. Workspace dependencies must also resolve inside it. */
export async function acquisitionCandidate() {
  const source = fileURLToPath(new URL("../../../../../../", import.meta.url));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "acquisition-candidate-")));
  try {
    const projects = ["apps/bench-runner", "apps/core-daemon",
      ...readdirSync(join(source, "packages")).map(name => `packages/${name}`)];
    cpSync(join(source, "package.json"), join(root, "package.json"));
    cpSync(join(source, "scripts"), join(root, "scripts"), { recursive: true });
    for (const project of projects) {
      for (const part of ["package.json", "src", "dist", "scripts"]) {
        const from = join(source, project, part), to = join(root, project, part);
        if (existsSync(from)) cpSync(from, to, { recursive: true,
          filter: path => !path.endsWith(".map") && !path.endsWith(".d.ts") });
      }
    }
    for (const project of ["", ...projects]) {
      const modules = join(source, project, "node_modules");
      if (!existsSync(modules)) continue;
      for (const name of readdirSync(modules)) {
        if (name.startsWith(".")) continue;
        const names = name.startsWith("@")
          ? readdirSync(join(modules, name)).map(child => `${name}/${child}`) : [name];
        for (const dependency of names) {
          const physical = realpathSync(join(modules, dependency));
          const workspace = relative(source, physical);
          const target = projects.some(projectRoot => workspace === projectRoot.split("/").join(sep))
            ? resolve(root, workspace) : physical;
          const link = join(root, project, "node_modules", dependency);
          mkdirSync(dirname(link), { recursive: true });
          symlinkSync(target, link, "junction");
        }
      }
    }
    const child = "packages/core/dist/embedding-recall/local-onnx-process/child.js";
    cpSync(new URL("./source-acquisition-model-child.test-support.mjs", import.meta.url), join(root, child));
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    for (const args of [["init", "--quiet"], ["add", "."],
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "isolated acquisition candidate"]]) {
      execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
    }
    const owner = createRequire(import.meta.url)(join(root,
      "apps/bench-runner/src/runs/semantic-chain/source-acquisition-launch.mjs")) as {
        captureAcquisitionLaunchBinding(): SourceAcquisitionExperimentInput["launch"];
      };
    const revisionOwner = await import(/* @vite-ignore */ pathToFileURL(join(root,
      "apps/bench-runner/dist/runs/extraction/authority/inspection.js")).href) as {
        readCurrentExtractionAuthorityRevision(): string;
      };
    return { root, capture: () => owner.captureAcquisitionLaunchBinding(),
      revision: () => revisionOwner.readCurrentExtractionAuthorityRevision(),
      caller: join(root, "apps/bench-runner/src/__tests__/runs/semantic-chain/source-acquisition-caller.test-support.mjs"),
      close: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
