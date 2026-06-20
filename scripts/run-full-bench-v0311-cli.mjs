import path from "node:path";

export function parseArgs(argv, defaults) {
  const args = {
    benches: undefined,
    policyShape: "chat",
    limit: undefined,
    dataDir: undefined,
    historyRoot: defaults.defaultHistoryRoot,
    logRoot: defaults.defaultLogRoot,
    dryRun: false,
    resume: false
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--bench") {
      args.benches = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (token === "--policy-shape") {
      args.policyShape = argv[++i] ?? args.policyShape;
    } else if (token === "--limit") {
      const raw = argv[++i];
      const parsed = Number.parseInt(raw ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--limit requires positive integer, got '${raw}'`);
      }
      args.limit = parsed;
    } else if (token === "--data-dir") {
      args.dataDir = argv[++i];
    } else if (token === "--history-root") {
      args.historyRoot = path.resolve(argv[++i] ?? args.historyRoot);
    } else if (token === "--log-root") {
      args.logRoot = path.resolve(argv[++i] ?? args.logRoot);
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--resume") {
      args.resume = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

export function selectSteps(ids, benchSteps) {
  if (!ids || ids.length === 0) return benchSteps;
  const known = new Map(benchSteps.map((s) => [s.id, s]));
  const picked = [];
  for (const id of ids) {
    const step = known.get(id);
    if (!step) {
      throw new Error(
        `unknown bench id '${id}'. valid: ${benchSteps.map((s) => s.id).join(", ")}`
      );
    }
    picked.push(step);
  }
  return picked;
}


export function formatDuration(ms) {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}


