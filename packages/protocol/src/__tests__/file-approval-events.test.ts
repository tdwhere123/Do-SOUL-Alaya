import { describe, expect, it } from "vitest";

const validTimestamp = "2026-03-31T00:00:00.000Z";
const approvalResolvedAt = "2026-04-01T08:30:00.000Z";

describe("Phase 5 protocol schemas", () => {
  it("parses file schemas and adds file-approval events to the global event union", async () => {
    const protocol = (await import("../" + "index.js")) as Record<string, unknown>;
    const SupportedMimeTypeSchema = protocol.SupportedMimeTypeSchema as {
      parse: (value: unknown) => unknown;
    };
    const FileRecordSchema = protocol.FileRecordSchema as {
      parse: (value: unknown) => unknown;
    };
    const FileUploadResponseSchema = protocol.FileUploadResponseSchema as {
      parse: (value: unknown) => unknown;
    };
    const FileApprovalEventType = protocol.FileApprovalEventType as Record<string, string>;
    const FileApprovalEventTypeSchema = protocol.FileApprovalEventTypeSchema as {
      options: readonly string[];
      parse: (value: unknown) => unknown;
    };
    const FileApprovalEventUnionSchema = protocol.FileApprovalEventUnionSchema as {
      parse: (value: unknown) => unknown;
    };
    const EventTypeSchema = protocol.EventTypeSchema as {
      parse: (value: unknown) => unknown;
    };
    const parseFileApprovalEventPayload = protocol.parseFileApprovalEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;
    const SoulInteractionRiskLevelSchema = protocol.SoulInteractionRiskLevelSchema as {
      parse: (value: unknown) => unknown;
    };
    const ApprovalResolutionResultSchema = protocol.ApprovalResolutionResultSchema as {
      parse: (value: unknown) => unknown;
    };

    expect(SupportedMimeTypeSchema.parse("image/png")).toBe("image/png");
    expect(SupportedMimeTypeSchema.parse("application/pdf")).toBe("application/pdf");
    expect(SoulInteractionRiskLevelSchema.parse("high")).toBe("high");
    expect(ApprovalResolutionResultSchema.parse("approved")).toBe("approved");

    const fileRecord = {
      file_id: "11111111-1111-4111-8111-111111111111",
      filename: "design.md",
      mime_type: "text/markdown",
      size_bytes: 512,
      storage_path: "11111111-1111-4111-8111-111111111111.md",
      workspace_id: "workspace-1",
      run_id: "run-1",
      created_at: validTimestamp
    } as const;

    expect(FileRecordSchema.parse(fileRecord)).toEqual(fileRecord);
    expect(
      FileUploadResponseSchema.parse({
        file_id: fileRecord.file_id,
        filename: fileRecord.filename,
        mime_type: fileRecord.mime_type,
        size_bytes: fileRecord.size_bytes
      })
    ).toEqual({
      file_id: fileRecord.file_id,
      filename: fileRecord.filename,
      mime_type: fileRecord.mime_type,
      size_bytes: fileRecord.size_bytes
    });

    const uploadedPayload = {
      file_id: fileRecord.file_id,
      filename: fileRecord.filename,
      mime_type: fileRecord.mime_type,
      size_bytes: fileRecord.size_bytes,
      workspace_id: fileRecord.workspace_id,
      run_id: fileRecord.run_id
    } as const;

    expect(parseFileApprovalEventPayload(FileApprovalEventType.FILE_UPLOADED, uploadedPayload)).toEqual(uploadedPayload);
    const hintPayload = {
      message_id: "msg_hint_1",
      hint: "Check the governance constraint before continuing.",
      source_kind: "governance"
    } as const;
    const correctionPayload = {
      message_id: "msg_correction_1",
      original: "Writing to package-lock.json",
      correction: "Use pnpm-lock.yaml instead.",
      source_kind: "garden"
    } as const;
    const explanationPayload = {
      message_id: "msg_explanation_1",
      title: "Why approval is required",
      explanation: "The action touches a protected path.",
      source_kind: "recall"
    } as const;
    const approvalRequestedPayload = {
      message_id: "msg_approval_1",
      approval_id: "approval-1",
      description: "Apply the generated patch to workspace files.",
      risk_level: "medium",
      source_kind: "governance",
      run_id: "run-1"
    } as const;
    const approvalResolvedPayload = {
      message_id: "msg_resolution_1",
      approval_id: "approval-1",
      result: "approved",
      description: "Apply the generated patch to workspace files.",
      resolved_at: approvalResolvedAt,
      risk_level: "medium",
      source_kind: "governance",
      run_id: "run-1"
    } as const;

    expect(parseFileApprovalEventPayload(FileApprovalEventType.SOUL_HINT_EMITTED, hintPayload)).toEqual(hintPayload);
    expect(parseFileApprovalEventPayload(FileApprovalEventType.SOUL_CORRECTION_ISSUED, correctionPayload)).toEqual(
      correctionPayload
    );
    expect(parseFileApprovalEventPayload(FileApprovalEventType.SOUL_EXPLANATION_PROVIDED, explanationPayload)).toEqual(
      explanationPayload
    );
    expect(parseFileApprovalEventPayload(FileApprovalEventType.SOUL_APPROVAL_REQUESTED, approvalRequestedPayload)).toEqual(
      approvalRequestedPayload
    );
    expect(parseFileApprovalEventPayload(FileApprovalEventType.SOUL_APPROVAL_RESOLVED, approvalResolvedPayload)).toEqual(
      approvalResolvedPayload
    );
    expect(FileApprovalEventTypeSchema.options).toEqual([
      FileApprovalEventType.FILE_UPLOADED,
      FileApprovalEventType.SOUL_HINT_EMITTED,
      FileApprovalEventType.SOUL_CORRECTION_ISSUED,
      FileApprovalEventType.SOUL_EXPLANATION_PROVIDED,
      FileApprovalEventType.SOUL_APPROVAL_REQUESTED,
      FileApprovalEventType.SOUL_APPROVAL_RESOLVED
    ]);
    expect(
      FileApprovalEventUnionSchema.parse({
        type: FileApprovalEventType.FILE_UPLOADED,
        payload: uploadedPayload
      })
    ).toEqual({
      type: FileApprovalEventType.FILE_UPLOADED,
      payload: uploadedPayload
    });
    expect(EventTypeSchema.parse(FileApprovalEventType.FILE_UPLOADED)).toBe(FileApprovalEventType.FILE_UPLOADED);
    expect(
      FileApprovalEventUnionSchema.parse({
        type: FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
        payload: approvalResolvedPayload
      })
    ).toEqual({
      type: FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
      payload: approvalResolvedPayload
    });
    expect(EventTypeSchema.parse(FileApprovalEventType.SOUL_APPROVAL_REQUESTED)).toBe(
      FileApprovalEventType.SOUL_APPROVAL_REQUESTED
    );
  });

  it("rejects invalid file records and file-approval payloads", async () => {
    const protocol = (await import("../" + "index.js")) as Record<string, unknown>;
    const FileRecordSchema = protocol.FileRecordSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const parseFileApprovalEventPayload = protocol.parseFileApprovalEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;
    const FileApprovalEventType = protocol.FileApprovalEventType as Record<string, string>;

    expect(
      FileRecordSchema.safeParse({
        file_id: "not-a-uuid",
        filename: "voice.mp3",
        mime_type: "audio/mpeg",
        size_bytes: 128,
        storage_path: "voice.mp3",
        workspace_id: null,
        run_id: null,
        created_at: validTimestamp
      }).success
    ).toBe(false);

    expect(() =>
      parseFileApprovalEventPayload(FileApprovalEventType.FILE_UPLOADED, {
        file_id: "11111111-1111-4111-8111-111111111111",
        filename: "bad.bin",
        mime_type: "application/octet-stream",
        size_bytes: 128,
        workspace_id: null,
        run_id: null
      })
    ).toThrow();

    expect(() =>
      parseFileApprovalEventPayload(FileApprovalEventType.SOUL_APPROVAL_REQUESTED, {
        message_id: "msg_approval_1",
        approval_id: "approval-1",
        description: "Apply patch",
        risk_level: "critical",
        run_id: "run-1"
      })
    ).toThrow();

    expect(() =>
      parseFileApprovalEventPayload(FileApprovalEventType.SOUL_APPROVAL_RESOLVED, {
        message_id: "msg_resolution_1",
        approval_id: "approval-1",
        result: "accepted",
        description: "Apply patch",
        resolved_at: approvalResolvedAt,
        run_id: "run-1"
      })
    ).toThrow();
  });
});
