import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AdmittedSemanticArtifact,
  SemanticArtifactRepositoryPort,
  SemanticArtifactWork,
  SemanticEnrichmentTask,
  SemanticSourceSnapshot,
  SemanticTransportAttempt
} from "@do-soul/alaya-protocol";
import { persistRawArtifact } from "./store.js";

/** File adapter of the production artifact port; historical run-root publication stays in store.ts. */
export class FileSemanticArtifactRepository implements SemanticArtifactRepositoryPort {
  public constructor(private readonly root: string) {}

  public source(_workspaceId: string, _objectId: string): SemanticSourceSnapshot | null {
    return null;
  }

  public isCurrent(_task: SemanticEnrichmentTask): boolean {
    return false;
  }

  public task(_workspaceId: string, _taskId: string): SemanticEnrichmentTask | null {
    return null;
  }

  public claim(_task: SemanticEnrichmentTask, _token: string, _now: string): boolean {
    throw unsupported("claim");
  }

  public recover(_task: SemanticEnrichmentTask): boolean {
    throw unsupported("recover");
  }

  public artifact(workspaceId: string, key: string): AdmittedSemanticArtifact | null {
    try {
      const parsed = JSON.parse(readFileSync(this.artifactPath(workspaceId, key), "utf8")) as AdmittedSemanticArtifact;
      if (parsed.key !== key || typeof parsed.rawJson !== "string" || typeof parsed.payloadJson !== "string") {
        throw new Error("semantic artifact persisted shape mismatch");
      }
      return Object.freeze({
        key: parsed.key, rawJson: parsed.rawJson, payloadJson: parsed.payloadJson, searchText: parsed.searchText
      });
    } catch (error) {
      if ((error as { readonly code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  public attempt(_taskId: string, _key: string): SemanticTransportAttempt | null {
    return null;
  }

  public acquireWork(_task: SemanticEnrichmentTask, _key: string, _expiredBefore: string): boolean {
    throw unsupported("acquireWork");
  }

  public beginReconcile(_task: SemanticEnrichmentTask, _attemptId: string): void {
    throw unsupported("beginReconcile");
  }

  public dispatch(_task: SemanticEnrichmentTask, _key: string, _attemptId: string): boolean {
    throw unsupported("dispatch");
  }

  public receive(_task: SemanticEnrichmentTask, _attemptId: string, _rawJson: string): void {
    throw unsupported("receive");
  }

  public uncertain(_task: SemanticEnrichmentTask, _attemptId: string): void {
    throw unsupported("uncertain");
  }

  public reconcile(_task: SemanticEnrichmentTask, _attemptId: string, _rawJson: string | null): void {
    throw unsupported("reconcile");
  }

  public put(task: SemanticEnrichmentTask, artifact: AdmittedSemanticArtifact): void {
    persistRawArtifact(this.root, artifact.rawJson);
    const existing = this.artifact(task.workspaceId, artifact.key);
    if (existing) {
      if (existing.payloadJson !== artifact.payloadJson || existing.searchText !== artifact.searchText) {
        throw new Error("immutable artifact conflict");
      }
      return;
    }
    const path = this.artifactPath(task.workspaceId, artifact.key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      key: artifact.key, rawJson: artifact.rawJson, payloadJson: artifact.payloadJson, searchText: artifact.searchText
    })}\n`);
  }

  public publish(
    _task: SemanticEnrichmentTask,
    _source: SemanticSourceSnapshot,
    _work: readonly SemanticArtifactWork[],
    _now: string
  ): number {
    throw unsupported("publish");
  }

  public finish(
    _task: SemanticEnrichmentTask,
    _status: "completed" | "failed",
    _reason: string | null,
    _now: string
  ): void {
    throw unsupported("finish");
  }

  public searchReady(_workspaceId: string, _query: string, _limit: number) {
    return [];
  }

  private artifactPath(workspaceId: string, key: string): string {
    return join(this.root, "admitted", workspaceId, `${key}.json`);
  }
}

function unsupported(method: string): Error {
  return new Error(`file semantic artifact adapter does not implement ${method}`);
}
