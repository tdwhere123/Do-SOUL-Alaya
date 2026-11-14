import fs from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Config data, atomic publication and the installer/runtime lock share one fixture owner. */
export function isNativeConfigFixtureFile(path) {
  const root = /^(.*[/\\]alaya-bench-config-[a-f0-9-]+)[/\\]\.env(?:\.runtime-embedding\.lock|\.[a-f0-9-]+\.tmp)?$/u.exec(path)?.[1];
  return root !== undefined && containedFixtureFile(path, root);
}

export function containedFixtureFile(path, root) {
  try {
    if (fs.realpathSync(root) !== root) return false;
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    // A fixture may read ordinary files, never another owner's shared credential inode.
    if (stat?.isFile() && stat.nlink > 1) return false;
    let ancestor = path;
    const suffix = [];
    for (;;) {
      try { ancestor = fs.realpathSync(ancestor); break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false;
        // Missing files are allowed, but a dangling symlink is not an owned missing file.
        if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
        const parent = dirname(ancestor);
        if (parent === ancestor) return false;
        suffix.unshift(relative(parent, ancestor)); ancestor = parent;
      }
    }
    const target = resolve(ancestor, ...suffix), within = relative(root, target);
    return within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
  } catch { return false; }
}
