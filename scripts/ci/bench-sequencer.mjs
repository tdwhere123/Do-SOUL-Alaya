import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";
import { benchShardPaths, filesDigest, partitionBenchFiles } from "./vitest-projects.mjs";

export default class BenchSequencer extends BaseSequencer {
  async shard(specifications) {
    const { root, shard } = this.ctx.config;
    const specs = new Map();
    for (const spec of specifications) {
      const file = path.relative(root, spec.moduleId).replaceAll("\\", "/");
      if (spec.project.name !== "@do-soul/alaya-bench-runner"
        || !file.startsWith("apps/bench-runner/src/__tests__/")) {
        throw new Error(`bench sequencer received unexpected test ${file}`);
      }
      if (specs.has(file)) throw new Error(`duplicate test file ${file}`);
      specs.set(file, spec);
    }
    const files = [...specs.keys()];
    const selected = partitionBenchFiles(files, shard.count)[shard.index - 1];
    const output = path.resolve(root, benchShardPaths(shard).partition);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({
      algorithm: "duration-lpt", count: files.length, digest: filesDigest(files), files: selected
    }));
    return selected.map((file) => specs.get(file));
  }
}
