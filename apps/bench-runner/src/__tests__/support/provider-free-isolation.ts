import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { threadId } from "node:worker_threads";

const SIGNAL_ENV = "ALAYA_PROVIDER_FREE_ISOLATION";
export const ISOLATION_SIGNAL_FAILURE_EXIT = 86;
const contract = "provider-free-isolation.v1";
type Binding = { root: string; member: string; identity: string };
type Entry = { parent: string | null; kind: string };

export class ProviderFreeIsolationError extends Error {
  readonly code = "PROVIDER_FREE_ISOLATION_FAILED";
  readonly evidence: string;
  readonly reasons: readonly string[];
  constructor(evidence: string, reasons: readonly string[]) {
    super(`Provider-free isolation failed; evidence: ${evidence}; ${reasons.join(", ")}`);
    this.evidence = evidence; this.reasons = [...reasons];
  }
}

/** A sticky guard-owned journal, not worker exit status or per-item result classification.
 * Each actor has private append-only files; registration precedes launch and readiness
 * precedes application import. Evidence outlives product quarantine/reaping and restore. */
export class ProviderFreeIsolation {
  readonly binding: Binding;
  private readonly faults: string[] = [];
  private readonly descendant: boolean;
  private reportedFault = false;

  constructor() {
    const inherited = process.env[SIGNAL_ENV];
    if (inherited === undefined) {
      const root = fs.mkdtempSync(join(tmpdir(), "alaya-provider-free-isolation-"));
      this.binding = { root, identity: randomUUID(), member: randomUUID() };
      this.descendant = false;
      this.write(join(root, "identity.json"), { contract, identity: this.binding.identity });
      fs.writeFileSync(join(root, "members.jsonl"), "", { flag: "wx", mode: 0o600 });
      this.register(this.binding.member, { parent: null, kind: "root" });
    } else {
      this.binding = JSON.parse(inherited) as Binding;
      const { root, member, identity } = this.binding;
      if (typeof root !== "string" || resolve(root) !== root || !root.startsWith(join(tmpdir(), "alaya-provider-free-isolation-"))
        || !/^[a-f0-9-]{36}$/u.test(member) || !/^[a-f0-9-]{36}$/u.test(identity)) throw new Error("Invalid isolation binding");
      const marker = this.read(join(root, "identity.json"));
      if (marker.contract !== contract || marker.identity !== identity) throw new Error("Isolation identity mismatch");
      this.descendant = this.read(this.path(member, "entry.json")).parent !== null;
    }
    const ready = this.path(this.binding.member, "ready.json");
    if (fs.existsSync(ready)) {
      const actor = this.read(ready);
      if (actor.pid !== process.pid || actor.thread !== threadId) throw new Error("Unregistered isolation descendant");
    }
  }

  ready(): void {
    const ready = this.path(this.binding.member, "ready.json");
    if (!fs.existsSync(ready)) this.record(this.binding.member, "ready.json", { pid: process.pid, thread: threadId });
    if (this.faults.length) throw new ProviderFreeIsolationError(this.binding.root, this.faults);
  }

  environment(env: NodeJS.ProcessEnv | undefined, member = this.binding.member): NodeJS.ProcessEnv {
    return { ...(env ?? process.env), [SIGNAL_ENV]: JSON.stringify({ ...this.binding, member }) };
  }

  reserve(kind: string): string {
    const member = randomUUID();
    this.register(member, { parent: this.binding.member, kind });
    return member;
  }

  violation(kind: string): void {
    this.faults.push(`violation:${kind}`);
    this.record(this.binding.member, `violation-${randomUUID()}.json`, { kind });
  }

  cancelled(member: string): void {
    const path = this.path(member, "cancellation.json");
    if (!fs.existsSync(path)) this.record(member, "cancellation.json", { requested: true });
  }

  exited(member: string, code: number | null, signal: string | null = null): void {
    // This listener belongs to the guard and is independent of product epochs/quarantine.
    if (code === ISOLATION_SIGNAL_FAILURE_EXIT) this.faults.push("descendant_signal_failure");
    if (signal !== null && !fs.existsSync(this.path(member, "cancellation.json"))) this.faults.push("unexpected_descendant_signal");
    this.record(member, "exit.json", { code, signal });
  }

  spawnFailed(member: string): void {
    this.faults.push("descendant_start_unknown");
    this.record(member, "start-failed.json", { status: "unknown" });
  }

  assertSafe(requireSettled = false): void {
    const reasons = [...this.faults];
    try {
      const marker = this.read(join(this.binding.root, "identity.json"));
      if (marker.contract !== contract || marker.identity !== this.binding.identity) reasons.push("signal_identity_changed");
      const registry = join(this.binding.root, "members.jsonl"), registryStat = fs.lstatSync(registry);
      if (!registryStat.isFile() || registryStat.isSymbolicLink() || registryStat.nlink !== 1) throw new Error("Invalid isolation registry");
      const registrations = fs.readFileSync(registry, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const members = registrations.map(row => row.member as string);
      if (new Set(members).size !== members.length || !members.includes(this.binding.member)) throw new Error("Invalid isolation registry");
      if (members.some(member => !/^[a-f0-9-]{36}$/u.test(member))) throw new Error("Unknown isolation member");
      const entries = new Map(members.map(member => [member, this.read(this.path(member, "entry.json"))]));
      for (const entry of entries.values()) {
        if (!(entry.parent === null || typeof entry.parent === "string" && entries.has(entry.parent))
          || !["root", "fork", "worker", "spawn", "spawnSync", "execFile", "execFileSync"].includes(String(entry.kind))) {
          reasons.push("invalid_registration_record");
        }
      }
      for (const member of members) {
        const names = fs.readdirSync(join(this.binding.root, member));
        if (!names.includes("ready.json") && names.includes("exit.json")) reasons.push(`unconfirmed_descendant:${member}`);
        if (requireSettled && member !== this.binding.member && !names.includes("exit.json")) {
          const seen = new Set<string>();
          let parent = entries.get(member)?.parent;
          while (typeof parent === "string") {
            if (seen.has(parent) || !entries.has(parent)) throw new Error("Invalid isolation ancestry");
            if (parent === this.binding.member) { reasons.push("descendant_cleanup_incomplete"); break; }
            seen.add(parent); parent = entries.get(parent)?.parent;
          }
        }
        for (const name of names) {
          const event = this.read(this.path(member, name));
          if (name === "ready.json" && (!Number.isInteger(event.pid) || Number(event.pid) <= 0
            || !Number.isInteger(event.thread) || Number(event.thread) < 0)) reasons.push("invalid_readiness_record");
          if (name === "exit.json" && (!(event.code === null || Number.isInteger(event.code) && Number(event.code) >= 0)
            || !(event.signal === null || typeof event.signal === "string"))) reasons.push("invalid_exit_record");
          if (name.startsWith("violation-")) reasons.push(`violation:${event.kind}`);
          if (name.startsWith("signal-failure-")) reasons.push("recorded_signal_failure");
          if (name === "start-failed.json") reasons.push("descendant_start_unknown");
          if (name === "exit.json" && (event.code === ISOLATION_SIGNAL_FAILURE_EXIT
            || event.signal !== null && !names.includes("cancellation.json"))) reasons.push("descendant_signal_unknown");
          if (!/^(?:entry|ready|exit|cancellation|start-failed)\.json$|^(?:violation|signal-failure)-[a-f0-9-]{36}\.json$/u.test(name)) {
            reasons.push("unknown_signal_record");
          }
        }
      }
    } catch { reasons.push("isolation_signal_unreadable"); }
    if (reasons.length) {
      this.faults.push(...reasons.filter(reason => !this.faults.includes(reason)));
      if (!this.reportedFault) {
        this.reportedFault = true;
        this.record(this.binding.member, `signal-failure-${randomUUID()}.json`, { reasons: [...new Set(reasons)] });
      }
      throw new ProviderFreeIsolationError(this.binding.root, [...new Set(reasons)]);
    }
  }

  private path(member: string, file: string): string { return join(this.binding.root, member, file); }
  private register(member: string, entry: Entry): void {
    try {
      fs.mkdirSync(join(this.binding.root, member), { mode: 0o700 });
      this.write(this.path(member, "entry.json"), entry);
      // One small O_APPEND write; no shared read/modify/write, truncation, or
      // recreation of a missing registry. A partial write is unknown, not absent.
      const fd = fs.openSync(join(this.binding.root, "members.jsonl"), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd), record = Buffer.from(`${JSON.stringify({ member })}\n`);
        if (!stat.isFile() || stat.nlink !== 1 || fs.writeSync(fd, record) !== record.length) throw new Error("Invalid isolation registration write");
      } finally { fs.closeSync(fd); }
    } catch { this.signalFailure(); throw new ProviderFreeIsolationError(this.binding.root, this.faults); }
  }
  private read(path: string): Record<string, unknown> {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) throw new Error("Invalid isolation record");
    const value: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid isolation record");
    return value as Record<string, unknown>;
  }
  private write(path: string, value: unknown): void { fs.writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 }); }
  private record(member: string, file: string, value: unknown): void {
    try { this.write(this.path(member, file), value); }
    catch { this.signalFailure(); }
  }
  private signalFailure(): void {
    this.faults.push("isolation_signal_write_failed");
    // Reserved guard status, never an ordinary item failure. No filesystem read
    // is needed to propagate a failure of the journal itself.
    if (this.descendant) process.exit(ISOLATION_SIGNAL_FAILURE_EXIT);
  }
}
