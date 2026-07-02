import { z, type ZodTypeAny } from "zod";

export function StandardResponseSchema<T extends ZodTypeAny>(dataSchema: T) {
  return z
    .object({
      success: z.literal(true),
      data: dataSchema
    })
    .readonly();
}

export function StandardConfigPatchResponseSchema<T extends ZodTypeAny>(dataSchema: T) {
  return z
    .object({
      success: z.literal(true),
      data: dataSchema,
      requires_daemon_restart: z.boolean().optional()
    })
    .readonly();
}

export const ConfigPatchAckResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.unknown().optional(),
    requires_daemon_restart: z.boolean().optional()
  })
  .readonly();

export function isStandardSuccessEnvelope(
  value: unknown
): value is { readonly success: true; readonly data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success: unknown }).success === true &&
    "data" in value
  );
}

export function unwrapStandardResponseData<T>(payload: unknown): T {
  if (!isStandardSuccessEnvelope(payload)) {
    return payload as T;
  }
  const { data } = payload;
  if (data === undefined) {
    return payload as T;
  }
  return data as T;
}

export function bindStandardResponse<T extends ZodTypeAny>(
  dataSchema: T,
  data: unknown
): z.infer<ReturnType<typeof StandardResponseSchema<T>>> {
  return StandardResponseSchema(dataSchema).parse({ success: true, data });
}

export function bindStandardConfigPatchResponse<T extends ZodTypeAny>(
  dataSchema: T,
  data: unknown,
  options?: { readonly requiresDaemonRestart?: boolean }
): z.infer<ReturnType<typeof StandardConfigPatchResponseSchema<T>>> {
  return StandardConfigPatchResponseSchema(dataSchema).parse({
    success: true,
    data,
    ...(options?.requiresDaemonRestart === undefined
      ? {}
      : { requires_daemon_restart: options.requiresDaemonRestart })
  });
}

export function createConfigRouteResponseSchema<T extends ZodTypeAny>(
  dataSchema: T,
  options?: { readonly allowPatchAck?: boolean }
) {
  const enveloped = z.object({
    success: z.literal(true),
    data: dataSchema,
    requires_daemon_restart: z.boolean().optional()
  });
  const flatSchema = dataSchema.refine(
    (value) =>
      !(
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "success" in value
      ),
    { message: "Invalid config payload" }
  );
  const variants: [z.ZodType, z.ZodType, ...z.ZodType[]] = [enveloped, flatSchema];
  if (options?.allowPatchAck === true) {
    variants.push(ConfigPatchAckResponseSchema);
  }
  return z.union(variants);
}

export function isZodValidationError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}
