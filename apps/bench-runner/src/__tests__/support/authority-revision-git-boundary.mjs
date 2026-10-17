import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const configArgs = ["-c", "core.autocrlf=true", "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false", "-c", "credential.helper=", "-c", "core.askPass="];
const fixedEnvironment = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
const ambientKeys = new Set(["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "ComSpec",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TMP", "TEMP", "TMPDIR", "LANG", "LC_CTYPE"]);
const credentialPath = path => /(?:^|[/\\])(?:[^/\\]+\.env|\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(path);
const refuse = () => { throw new Error("unsupported authority Git context"); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Opt-in command admission for the existing revision reader, not a revision
 * implementation. Unsupported repositories fail closed rather than broadening Git.
 * Like the surrounding JS guard, this assumes a non-hostile concurrent filesystem. */
export function createAuthorityRevisionGitPolicy(checkout) {
  if (!isAbsolute(checkout) || realpathSync(checkout) !== checkout || realpathSync(process.cwd()) !== checkout) refuse();
  let untracked = new Set();
  return {
    prepare(command, args, options) {
      if (command !== "git" || !Array.isArray(args) || !same(args.slice(0, configArgs.length), configArgs) ||
          options === null || typeof options !== "object" || options.cwd !== checkout ||
          Object.keys(options).some(key => !["cwd", "env", "encoding", "stdio", "maxBuffer"].includes(key)) ||
          !same(options.stdio, ["ignore", "pipe", "ignore"])) refuse();
      const env = options.env;
      if (!env || Object.entries(fixedEnvironment).some(([key, value]) => env[key] !== value) ||
          Object.keys(env).some(key => !Object.hasOwn(fixedEnvironment, key) &&
            (!ambientKeys.has(key) || env[key] !== process.env[key]))) refuse();
      const tail = args.slice(configArgs.length);
      let operation;
      if (same(tail, ["rev-parse", "HEAD", "--show-toplevel"])) operation = "identity";
      else if (same(tail, ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"])) operation = "diff";
      else if (same(tail, ["--no-pager", "ls-files", "--others", "--exclude-standard", "-z"])) operation = "untracked";
      else if (same(tail.slice(0, 3), ["hash-object", "--no-filters", "--"]) && tail.length > 3) {
        operation = "hash";
        for (const path of tail.slice(3)) {
          if (!untracked.has(path)) refuse();
          assertWorktreePath(checkout, path, false);
        }
      } else refuse();
      const buffer = operation === "diff" || operation === "untracked";
      if (options.encoding !== (buffer ? "buffer" : "utf8") ||
          (buffer ? options.maxBuffer !== 64 * 1024 * 1024 : options.maxBuffer !== undefined)) refuse();
      inspectRepository(checkout);
      return operation;
    },
    observe(operation, result) {
      if (operation === "untracked") {
        untracked = new Set();
        const paths = result.toString("utf8").split("\0").filter(Boolean);
        for (const path of paths) assertWorktreePath(checkout, path, false);
        untracked = new Set(paths);
      }
    }
  };
}

function regular(path) {
  if (realpathSync(path) !== resolve(path) || !lstatSync(path).isFile()) refuse();
  return readFileSync(path);
}

function inspectRepository(checkout) {
  const dotGit = join(checkout, ".git");
  let gitDir = dotGit, common = dotGit;
  if (lstatSync(dotGit).isFile()) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(regular(dotGit).toString());
    if (!match) refuse();
    gitDir = resolve(checkout, match[1]);
    common = resolve(gitDir, regular(join(gitDir, "commondir")).toString().trim());
    if (resolve(gitDir, regular(join(gitDir, "gitdir")).toString().trim()) !== dotGit) refuse();
  }
  for (const directory of new Set([gitDir, common, join(common, "objects")])) {
    if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) refuse();
  }
  inspectConfig(join(common, "config"));
  if (existsSync(join(gitDir, "config.worktree"))) inspectConfig(join(gitDir, "config.worktree"));
  for (const path of ["objects/info/alternates", "objects/info/http-alternates", "info/grafts", "shallow.lock"]) {
    if (existsSync(join(common, path))) refuse();
  }
  if (existsSync(join(checkout, ".gitmodules"))) refuse();
  // A promisor object store can lazily fetch during an otherwise read-only diff.
  const packs = join(common, "objects/pack");
  if (existsSync(packs) && readdirSync(packs).some(name => name.endsWith(".promisor"))) refuse();
  for (const path of [join(gitDir, "HEAD"), join(gitDir, "index"), join(common, "packed-refs"),
    join(common, "info/attributes"), join(common, "info/exclude")]) {
    if (existsSync(path)) regular(path);
  }
  // Object fanout/pack/info entries cannot redirect reads outside bound metadata.
  inspectMetadataTree(join(common, "objects"));
  if (existsSync(join(common, "refs"))) inspectMetadataTree(join(common, "refs"));
  inspectIndex(checkout, regular(join(gitDir, "index")));
}

function inspectConfig(path) {
  let section = "";
  for (const raw of regular(path).toString("utf8").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || /^[#;]/u.test(line)) continue;
    const header = /^\[([a-z]+)(?: "[^"\\]*")?\]$/iu.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    const entry = /^([a-z][a-z0-9-]*)\s*=\s*(.*?)\s*$/iu.exec(line);
    if (!entry) refuse();
    const key = entry[1].toLowerCase(), value = entry[2].toLowerCase();
    // These settings are inert for the admitted operations. In particular no
    // includes, diff/textconv/filter drivers, fsmonitor, hooks, worktree redirects,
    // partial-clone, external attributes/excludes, or object-format extensions.
    if (section === "core" && ((key === "repositoryformatversion" && value === "0") ||
        (key === "bare" && value === "false") ||
        (["filemode", "logallrefupdates", "symlinks", "ignorecase", "precomposeunicode", "protectntfs", "protecthfs"].includes(key) && /^(true|false)$/u.test(value)) ||
        (key === "autocrlf" && /^(true|false|input)$/u.test(value)))) continue;
    if (section === "extensions" && key === "worktreeconfig" && value === "true") continue;
    if (section === "remote" && ["url", "fetch"].includes(key)) continue;
    if (section === "branch" && ["remote", "merge", "vscode-merge-base"].includes(key)) continue;
    if (section === "user" && ["name", "email"].includes(key)) continue;
    refuse();
  }
}

function inspectMetadataTree(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) refuse();
    if (stat.isDirectory()) inspectMetadataTree(path);
    else if (!stat.isFile()) refuse();
  }
}

function assertRelativeWorktreePath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") ||
      path.includes("\0") || credentialPath(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) refuse();
}

function assertWorktreePath(checkout, path, symlink) {
  assertRelativeWorktreePath(path);
  const filename = join(checkout, path), parent = resolve(filename, "..");
  if (relative(checkout, realpathSync(parent)).split(sep).includes("..") || realpathSync(parent) !== parent) refuse();
  const stat = lstatSync(filename);
  if (symlink && stat.isSymbolicLink()) return;
  if (!stat.isFile() || realpathSync(filename) !== filename) refuse();
}

function inspectIndex(checkout, index) {
  // Git index v2/v3 are supported; sparse/split/v4 and gitlinks are deliberately
  // refused so diff cannot launch nested Git/submodule helpers.
  if (index.toString("ascii", 0, 4) !== "DIRC" || ![2, 3].includes(index.readUInt32BE(4))) refuse();
  const count = index.readUInt32BE(8);
  let offset = 12;
  for (let n = 0; n < count; n++) {
    const start = offset;
    if (offset + 62 > index.length - 20) refuse();
    const mode = index.readUInt32BE(offset + 24), flags = index.readUInt16BE(offset + 60);
    if (![0o100644, 0o100755, 0o120000].includes(mode)) refuse();
    offset += 62 + (flags & 0x4000 ? 2 : 0);
    const end = index.indexOf(0, offset);
    if (end < offset || end >= index.length - 20) refuse();
    const path = index.toString("utf8", offset, end);
    assertRelativeWorktreePath(path);
    // Deletions are real dirty state, not a reason to invent clean contents.
    if (existsSync(join(checkout, path))) assertWorktreePath(checkout, path, mode === 0o120000);
    offset = start + Math.ceil((end + 1 - start) / 8) * 8;
  }
  while (offset < index.length - 20) {
    if (offset + 8 > index.length - 20 || !["TREE", "REUC", "UNTR", "EOIE", "IEOT"].includes(index.toString("ascii", offset, offset + 4))) refuse();
    offset += 8 + index.readUInt32BE(offset + 4);
  }
  if (offset !== index.length - 20) refuse();
}
