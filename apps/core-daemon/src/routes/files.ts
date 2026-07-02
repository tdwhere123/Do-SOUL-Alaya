import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Context, Hono } from "hono";
import {
  FileApprovalEventType,
  type EventLogEntry,
  type FileRecord,
  type FileUploadResponse,
  type SupportedMimeType
} from "@do-soul/alaya-protocol";
import {
  reportAsyncSideEffectFailure,
  resolveStoredFilePath,
  type AsyncSideEffectAuditEventLogPort
} from "@do-soul/alaya-core";
import type { FileRepo } from "@do-soul/alaya-storage";

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

const DIRECT_MIME_TYPES = new Set<SupportedMimeType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml"
]);

const GENERIC_MIME_TYPES = new Set<string>([
  "",
  "application/octet-stream",
  "binary/octet-stream"
]);

const EXTENSION_MIME_TYPES = new Map<string, SupportedMimeType>([
  [".txt", "text/plain"],
  [".log", "text/plain"],
  [".md", "text/markdown"],
  [".mdx", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".xml", "application/xml"],
  [".yml", "text/plain"],
  [".yaml", "text/plain"],
  [".toml", "text/plain"],
  [".ini", "text/plain"],
  [".cfg", "text/plain"],
  [".conf", "text/plain"],
  [".ts", "text/plain"],
  [".tsx", "text/plain"],
  [".js", "text/plain"],
  [".jsx", "text/plain"],
  [".mjs", "text/plain"],
  [".cjs", "text/plain"],
  [".css", "text/plain"],
  [".scss", "text/plain"],
  [".less", "text/plain"],
  [".sql", "text/plain"],
  [".sh", "text/plain"],
  [".bash", "text/plain"],
  [".zsh", "text/plain"],
  [".ps1", "text/plain"],
  [".py", "text/plain"],
  [".rb", "text/plain"],
  [".go", "text/plain"],
  [".rs", "text/plain"],
  [".java", "text/plain"],
  [".kt", "text/plain"],
  [".swift", "text/plain"],
  [".c", "text/plain"],
  [".cc", "text/plain"],
  [".cpp", "text/plain"],
  [".cxx", "text/plain"],
  [".h", "text/plain"],
  [".hpp", "text/plain"],
  [".cs", "text/plain"],
  [".php", "text/plain"],
  [".vue", "text/plain"],
  [".svelte", "text/plain"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
]);

type UploadBodyValue = string | File;

export interface FileRouteServices {
  readonly workspaceService: {
    getById(workspaceId: string): Promise<{ readonly workspace_id: string }>;
  };
  readonly runService: {
    getById(runId: string): Promise<{ readonly run_id: string; readonly workspace_id: string }>;
  };
  readonly fileRepo: FileRepo;
  readonly eventLogRepo: AsyncSideEffectAuditEventLogPort;
  readonly runtimeNotifier: {
    notifyEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly filesDirectory: string;
}

export function registerFileRoutes(app: Hono, services: FileRouteServices): void {
  app.post("/files", async (context) => {
    return await uploadFile(context, services);
  });

  app.get("/files/:id", async (context) => {
    return await downloadFile(context, services);
  });
}

async function uploadFile(context: Context, services: FileRouteServices): Promise<Response> {
  const upload = await readUploadRequest(context);
  if (upload instanceof Response) return upload;
  const scope = await resolveScope(services, upload.requestedRunId, upload.requestedWorkspaceId);
  const mismatch = rejectWorkspaceRunMismatch(context, upload, scope);
  if (mismatch !== null) return mismatch;
  const record = buildFileRecord(upload.file, upload.normalizedMimeType, scope);
  const absolutePath = join(services.filesDirectory, record.storage_path);
  await mkdir(services.filesDirectory, { recursive: true });
  await writeFile(absolutePath, Buffer.from(await upload.file.arrayBuffer()));
  let stored: Awaited<ReturnType<typeof persistFileRecord>>;
  try {
    stored = await persistFileRecord(services, record);
  } catch (error) {
    await bestEffortDelete(absolutePath);
    throw error;
  }
  await notifyFileUploadEvent(services, stored.record, stored.event);
  return context.json({ success: true, data: toUploadResponse(stored.record) }, 201);
}

async function readUploadRequest(context: Context): Promise<FileUploadRequest | Response> {
  const body = await context.req.parseBody();
  const file = getUploadedFile(body.file);
  if (file === null) return context.json({ success: false, error: "file is required" }, 400);
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return context.json({ success: false, error: "File exceeds the 20 MB limit" }, 422);
  }
  const normalizedMimeType = normalizeMimeType(file.name, file.type);
  if (normalizedMimeType === null) {
    return context.json({ success: false, error: "Unsupported file type" }, 422);
  }
  const requestedWorkspaceId = normalizeOptionalBodyString(body.workspace_id);
  const requestedRunId = normalizeOptionalBodyString(body.run_id);
  if (requestedRunId === null && requestedWorkspaceId === null) {
    return context.json({ success: false, error: "run_id or workspace_id is required" }, 400);
  }
  return { file, normalizedMimeType, requestedWorkspaceId, requestedRunId };
}

type FileUploadRequest = {
  readonly file: File;
  readonly normalizedMimeType: SupportedMimeType;
  readonly requestedWorkspaceId: string | null;
  readonly requestedRunId: string | null;
};

function rejectWorkspaceRunMismatch(
  context: Context,
  upload: FileUploadRequest,
  scope: Readonly<{ workspace_id: string | null; run_id: string | null }>
): Response | null {
  if (upload.requestedRunId === null || upload.requestedWorkspaceId === null) return null;
  if (upload.requestedWorkspaceId === scope.workspace_id) return null;
  return context.json({ success: false, error: "workspace_id does not match the run workspace" }, 422);
}

function buildFileRecord(
  file: File,
  normalizedMimeType: SupportedMimeType,
  scope: Readonly<{ workspace_id: string | null; run_id: string | null }>
): FileRecord {
  const fileId = randomUUID();
  return {
    file_id: fileId,
    filename: file.name,
    mime_type: normalizedMimeType,
    size_bytes: file.size,
    storage_path: `${fileId}${extname(file.name).toLowerCase()}`,
    workspace_id: scope.workspace_id,
    run_id: scope.run_id,
    created_at: new Date().toISOString()
  };
}

async function downloadFile(context: Context, services: FileRouteServices): Promise<Response> {
  const fileId = context.req.param("id")!.trim();
  const workspaceId = context.req.query("workspace_id")?.trim();
  if (workspaceId === undefined || workspaceId.length === 0) {
    return context.json({ success: false, error: "workspace_id is required" }, 400);
  }
  try {
    await services.workspaceService.getById(workspaceId);
  } catch {
    return fileNotFound(context);
  }
  const record = await services.fileRepo.findById(fileId);
  if (record === null || record.workspace_id !== workspaceId) {
    return fileNotFound(context);
  }
  const absolutePath = resolveStoredFilePath(services.filesDirectory, record.storage_path);
  if (absolutePath === null) return fileNotFound(context);
  try {
    return await sendStoredFile(context, record, absolutePath);
  } catch (error) {
    return mapFileReadErrorToResponse(context, error);
  }
}

function mapFileReadErrorToResponse(context: Context, error: unknown): Response {
  const classification = classifyFileReadError(error);
  if (classification === "not_found") {
    return fileNotFound(context);
  }
  if (classification === "forbidden") {
    return context.json({ success: false, error: "File access denied" }, 403);
  }
  return context.json({ success: false, error: "Failed to read stored file" }, 500);
}

function classifyFileReadError(error: unknown): "not_found" | "forbidden" | "storage_failure" {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "storage_failure";
  }
  const code = (error as { readonly code?: unknown }).code;
  if (code === "ENOENT") {
    return "not_found";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "forbidden";
  }
  return "storage_failure";
}

async function sendStoredFile(context: Context, record: FileRecord, absolutePath: string): Promise<Response> {
  const bytes = await readFile(absolutePath);
  context.header("Content-Type", record.mime_type);
  context.header("Content-Length", String(bytes.byteLength));
  context.header("Content-Disposition", buildDispositionHeader(record.filename));
  context.header("X-Content-Type-Options", "nosniff");
  return context.body(bytes);
}

function fileNotFound(context: Context): Response {
  return context.json({ success: false, error: "File not found" }, 404);
}

function getUploadedFile(value: UploadBodyValue | UploadBodyValue[] | undefined): File | null {
  if (value instanceof File) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item instanceof File) {
        return item;
      }
    }
  }

  return null;
}

async function resolveScope(
  services: FileRouteServices,
  requestedRunId: string | null,
  requestedWorkspaceId: string | null
): Promise<Readonly<{ workspace_id: string | null; run_id: string | null }>> {
  if (requestedRunId !== null) {
    const run = await services.runService.getById(requestedRunId);
    return {
      workspace_id: run.workspace_id,
      run_id: run.run_id
    };
  }

  if (requestedWorkspaceId !== null) {
    const workspace = await services.workspaceService.getById(requestedWorkspaceId);
    return {
      workspace_id: workspace.workspace_id,
      run_id: null
    };
  }

  return {
    workspace_id: null,
    run_id: null
  };
}

async function persistFileRecord(
  services: FileRouteServices,
  record: FileRecord
): Promise<Readonly<{ record: Readonly<FileRecord>; event: EventLogEntry }>> {
  if (record.workspace_id === null) {
    throw new Error("Invariant violation: workspace_id must be resolved before persisting a file");
  }

  const created = await services.fileRepo.createWithEvent(record, {
    event_type: FileApprovalEventType.FILE_UPLOADED,
    entity_type: "file",
    entity_id: record.file_id,
    workspace_id: record.workspace_id,
    run_id: record.run_id,
    caused_by: "user_action",
    payload_json: {
      file_id: record.file_id,
      filename: record.filename,
      mime_type: record.mime_type,
      size_bytes: record.size_bytes,
      workspace_id: record.workspace_id,
      run_id: record.run_id
    }
  });

  return {
    record: created.record,
    event: created.event
  };
}

async function notifyFileUploadEvent(
  services: FileRouteServices,
  record: Readonly<FileRecord>,
  event: EventLogEntry
): Promise<void> {
  try {
    await services.runtimeNotifier.notifyEntry(event);
  } catch (error) {
    await reportAsyncSideEffectFailure(
      {
        source: "daemon.files.upload",
        operation: "runtime_notify",
        subjectType: "file",
        subjectId: record.file_id,
        workspaceId: record.workspace_id ?? "[unknown]",
        runId: record.run_id,
        causedBy: "user_action",
        committedEventId: event.event_id,
        severity: "error",
        warningCode: "ALAYA_FILE_NOTIFY_FAILED",
        warningMessage: "[FileRoute] file upload notification failed",
        eventLogRepo: services.eventLogRepo,
        runtimeNotifier: services.runtimeNotifier
      },
      error
    );
  }
}

function normalizeOptionalBodyString(value: UploadBodyValue | UploadBodyValue[] | undefined): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        const trimmed = item.trim();

        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
}

function normalizeMimeType(filename: string, mimeType: string): SupportedMimeType | null {
  const normalizedMimeType = mimeType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";

  if (DIRECT_MIME_TYPES.has(normalizedMimeType as SupportedMimeType)) {
    return normalizedMimeType as SupportedMimeType;
  }

  if (!GENERIC_MIME_TYPES.has(normalizedMimeType)) {
    return null;
  }

  return EXTENSION_MIME_TYPES.get(extname(filename).toLowerCase()) ?? null;
}

function toUploadResponse(record: Readonly<FileRecord>): FileUploadResponse {
  return {
    file_id: record.file_id,
    filename: record.filename,
    mime_type: record.mime_type,
    size_bytes: record.size_bytes
  };
}

function buildDispositionHeader(filename: string): string {
  const normalizedFilename = basename(filename);
  return `attachment; filename="${toAsciiDispositionFilename(normalizedFilename)}"; filename*=UTF-8''${encodeDispositionFilename(normalizedFilename)}`;
}

function toAsciiDispositionFilename(filename: string): string {
  const normalized = basename(filename).replace(/[^ -~]|["\\/%;\r\n]/g, "_");
  return normalized.length > 0 ? normalized : "download";
}

function encodeDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replaceAll("'", "%27").replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("*", "%2A");
}

async function bestEffortDelete(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Best effort cleanup only.
  }
}
