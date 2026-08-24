import ts from "typescript";
import path from "node:path";
import fs from "node:fs";

const projectPath = path.resolve(process.argv[2]);
const configFile = ts.readConfigFile(projectPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  path.dirname(projectPath)
);

const files = new Map(parsed.fileNames.map((name) => [name, { version: 0 }]));

const host = {
  getScriptFileNames: () => [...files.keys()],
  getScriptVersion: (name) => String(files.get(name)?.version ?? 0),
  getScriptSnapshot: (name) => {
    if (!fs.existsSync(name)) return undefined;
    return ts.ScriptSnapshot.fromString(fs.readFileSync(name, "utf8"));
  },
  getCurrentDirectory: () => path.dirname(projectPath),
  getCompilationSettings: () => parsed.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const UNUSED_CODES = new Set([6133, 6192, 6196, 6198, 6199, 6205]);

const formatOptions = {
  ...ts.getDefaultFormatCodeSettings("\n"),
  convertTabsToSpaces: true,
  indentSize: 2,
  tabSize: 2
};

let changedFiles = 0;
for (const fileName of files.keys()) {
  const diagnostics = service.getSuggestionDiagnostics(fileName)
    .concat(service.getSemanticDiagnostics(fileName));
  const unused = diagnostics.filter((d) => UNUSED_CODES.has(d.code));
  if (unused.length === 0) continue;
  const first = unused[0];
  const actions = service.getCodeFixesAtPosition(
    fileName,
    first.start,
    first.start + first.length,
    [first.code],
    formatOptions,
    {}
  );
  const fixId = actions.find((action) => action.fixId !== undefined)?.fixId;
  if (fixId === undefined) {
    console.log(`no fixId for ${fileName}: ${first.code}`);
    continue;
  }
  const combined = service.getCombinedCodeFix(
    { type: "file", fileName },
    fixId,
    formatOptions,
    {}
  );
  let applied = false;
  for (const change of combined.changes) {
    if (change.fileName !== fileName) {
      console.log(`skip cross-file edit ${change.fileName}`);
      continue;
    }
    let text = fs.readFileSync(change.fileName, "utf8");
    for (const edit of [...change.textChanges].sort((a, b) => b.span.start - a.span.start)) {
      text = text.slice(0, edit.span.start) +
        edit.newText +
        text.slice(edit.span.start + edit.span.length);
    }
    fs.writeFileSync(change.fileName, text);
    applied = true;
  }
  if (applied) {
    changedFiles += 1;
    files.get(fileName).version += 1;
    console.log(`fixed ${path.relative(process.cwd(), fileName)}`);
  }
}
console.log(`changed ${changedFiles} files`);
