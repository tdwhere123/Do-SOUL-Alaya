import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema, PositiveIntSchema } from "./schema-primitives.js";

const fileToolErrorCodeValues = [
  "NOT_FOUND",
  "ACCESS_DENIED",
  "SIZE_EXCEEDED",
  "READ_ERROR",
  "WRITE_ERROR",
  "TIMEOUT",
  "EXEC_ERROR"
] as const;

export const FileToolName = {
  READ_FILE: "tools.read_file",
  LIST_DIRECTORY: "tools.list_directory",
  SEARCH_FILES: "tools.search_files",
  WRITE_FILE: "tools.write_file",
  EXEC_SHELL: "tools.exec_shell"
} as const;

export const FILE_TOOL_NAME_VALUES = [
  FileToolName.READ_FILE,
  FileToolName.LIST_DIRECTORY,
  FileToolName.SEARCH_FILES,
  FileToolName.WRITE_FILE,
  FileToolName.EXEC_SHELL
] as const;

export const FileToolNameSchema = z.enum(FILE_TOOL_NAME_VALUES);
export const FileToolErrorCodeSchema = z.enum(fileToolErrorCodeValues);

export const FileToolErrorSchema = z.object({
  ok: z.literal(false),
  code: FileToolErrorCodeSchema,
  message: NonEmptyStringSchema
}).strict();

export const ReadFileToolInputSchema = z.object({
  path: NonEmptyStringSchema,
  maxBytes: PositiveIntSchema.optional()
}).strict();

export const ReadFileToolSuccessSchema = z.object({
  ok: z.literal(true),
  content: z.string(),
  bytesRead: NonNegativeIntSchema
}).strict();

export const ReadFileToolResultSchema = z.discriminatedUnion("ok", [
  ReadFileToolSuccessSchema,
  FileToolErrorSchema
]);

export const ListDirectoryEntrySchema = z.object({
  name: NonEmptyStringSchema,
  isDirectory: z.boolean()
}).strict();

export const ListDirectoryToolInputSchema = z.object({
  path: NonEmptyStringSchema
}).strict();

export const ListDirectoryToolSuccessSchema = z.object({
  ok: z.literal(true),
  entries: z.array(ListDirectoryEntrySchema).readonly()
}).strict();

export const ListDirectoryToolResultSchema = z.discriminatedUnion("ok", [
  ListDirectoryToolSuccessSchema,
  FileToolErrorSchema
]);

export const SearchFilesToolInputSchema = z.object({
  pattern: NonEmptyStringSchema,
  baseDir: NonEmptyStringSchema,
  maxResults: PositiveIntSchema.optional()
}).strict();

export const SearchFilesToolSuccessSchema = z.object({
  ok: z.literal(true),
  paths: z.array(NonEmptyStringSchema).readonly()
}).strict();

export const SearchFilesToolResultSchema = z.discriminatedUnion("ok", [
  SearchFilesToolSuccessSchema,
  FileToolErrorSchema
]);

export const WriteFileToolInputSchema = z.object({
  path: NonEmptyStringSchema,
  content: z.string()
}).strict();

export const WriteFileToolSuccessSchema = z.object({
  ok: z.literal(true),
  bytesWritten: NonNegativeIntSchema
}).strict();

export const WriteFileToolResultSchema = z.discriminatedUnion("ok", [
  WriteFileToolSuccessSchema,
  FileToolErrorSchema
]);

export const ExecShellToolInputSchema = z.object({
  command: NonEmptyStringSchema,
  args: z.array(z.string()).readonly().optional(),
  timeoutMs: PositiveIntSchema.optional()
}).strict();

export const ExecShellToolSuccessSchema = z.object({
  ok: z.literal(true),
  exitCode: NonNegativeIntSchema,
  stdout: z.string(),
  stderr: z.string()
}).strict();

export const ExecShellToolResultSchema = z.discriminatedUnion("ok", [
  ExecShellToolSuccessSchema,
  FileToolErrorSchema
]);

export type FileToolName = z.infer<typeof FileToolNameSchema>;
export type FileToolErrorCode = z.infer<typeof FileToolErrorCodeSchema>;
export type FileToolError = z.infer<typeof FileToolErrorSchema>;
export type ReadFileToolInput = z.infer<typeof ReadFileToolInputSchema>;
export type ReadFileToolSuccess = z.infer<typeof ReadFileToolSuccessSchema>;
export type ReadFileToolResult = z.infer<typeof ReadFileToolResultSchema>;
export type ListDirectoryEntry = z.infer<typeof ListDirectoryEntrySchema>;
export type ListDirectoryToolInput = z.infer<typeof ListDirectoryToolInputSchema>;
export type ListDirectoryToolSuccess = z.infer<typeof ListDirectoryToolSuccessSchema>;
export type ListDirectoryToolResult = z.infer<typeof ListDirectoryToolResultSchema>;
export type SearchFilesToolInput = z.infer<typeof SearchFilesToolInputSchema>;
export type SearchFilesToolSuccess = z.infer<typeof SearchFilesToolSuccessSchema>;
export type SearchFilesToolResult = z.infer<typeof SearchFilesToolResultSchema>;
export type WriteFileToolInput = z.infer<typeof WriteFileToolInputSchema>;
export type WriteFileToolSuccess = z.infer<typeof WriteFileToolSuccessSchema>;
export type WriteFileToolResult = z.infer<typeof WriteFileToolResultSchema>;
export type ExecShellToolInput = z.infer<typeof ExecShellToolInputSchema>;
export type ExecShellToolSuccess = z.infer<typeof ExecShellToolSuccessSchema>;
export type ExecShellToolResult = z.infer<typeof ExecShellToolResultSchema>;
