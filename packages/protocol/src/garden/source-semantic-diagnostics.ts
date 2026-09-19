import { z } from "zod";

const MAX_DIAGNOSTIC_JSON_CHARS = 8192;

/** Diagnostics are bounded metadata; the retained response remains the evidence. */
export const SourceSemanticDiagnosticsSchema = z.array(z.object({
  code: z.string().max(64),
  path: z.array(z.union([z.string().max(64), z.number().int()])).max(32).readonly(),
  message: z.string().max(256),
  reference: z.string().max(64).optional()
}).strict().readonly()).max(32).superRefine((diagnostics, context) => {
  if (JSON.stringify(diagnostics).length > MAX_DIAGNOSTIC_JSON_CHARS) context.addIssue({ code: "custom", message: "diagnostics exceed retained metadata bound" });
}).readonly();

export function sourceSemanticValidationDiagnostics(error: z.ZodError) {
  const diagnostics: z.infer<typeof SourceSemanticDiagnosticsSchema>[number][] = [];
  for (const issue of error.issues.slice(0, 32)) {
    const params = issue.code === "custom" ? issue.params : undefined;
    const diagnostic = {
      code: typeof params?.diagnostic_code === "string" ? params.diagnostic_code.slice(0, 64) : issue.code,
      path: issue.path.slice(0, 32).map((part) => typeof part === "number" ? part : String(part).slice(0, 64)),
      message: issue.message.slice(0, 256),
      ...(typeof params?.reference === "string" ? { reference: params.reference.slice(0, 64) } : {})
    };
    if (JSON.stringify([...diagnostics, diagnostic]).length > MAX_DIAGNOSTIC_JSON_CHARS) break;
    diagnostics.push(diagnostic);
  }
  return SourceSemanticDiagnosticsSchema.parse(diagnostics);
}
