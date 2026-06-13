import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

const EXTENSION_ID_MAX_LENGTH = 256;
const EXTENSION_NAME_MAX_LENGTH = 512;
const EXTENSION_DESCRIPTION_MAX_LENGTH = 4096;
const EXTENSION_VERSION_MAX_LENGTH = 64;
const EXTENSION_PATTERN_MAX_LENGTH = 512;
const EXTENSION_ENDPOINT_MAX_LENGTH = 2048;

const ExtensionBoundedStringSchema = (maxLength: number) => NonEmptyStringSchema.max(maxLength);
const ExtensionIdSchema = ExtensionBoundedStringSchema(EXTENSION_ID_MAX_LENGTH);
const ExtensionNameSchema = ExtensionBoundedStringSchema(EXTENSION_NAME_MAX_LENGTH);
const ExtensionDescriptionSchema = ExtensionBoundedStringSchema(EXTENSION_DESCRIPTION_MAX_LENGTH);
const ExtensionVersionSchema = ExtensionBoundedStringSchema(EXTENSION_VERSION_MAX_LENGTH);
const ExtensionPatternSchema = ExtensionBoundedStringSchema(EXTENSION_PATTERN_MAX_LENGTH);
const ExtensionEndpointSchema = ExtensionBoundedStringSchema(EXTENSION_ENDPOINT_MAX_LENGTH)
  .url()
  .refine(isAllowedExtensionEndpoint, {
    message: "endpoint must use https or trusted local http"
  });

export const ExtensionSourceSchema = z.enum([
  "builtin",
  "mcp_external",
  "skill_package",
  "user_configured"
]);

export const ExtensionDescriptorTypeSchema = z.enum([
  "tool_provider",
  "skill_package",
  "hook_policy",
  "agent_profile",
  "integration"
]);

export const ToolProviderToolSpecSchema = z
  .object({
    tool_id: ExtensionIdSchema,
    name: ExtensionNameSchema,
    description: ExtensionDescriptionSchema
  })
  .strict()
  .readonly();

export const SkillPackageSchema = z
  .object({
    skill_id: ExtensionIdSchema,
    name: ExtensionNameSchema,
    version: ExtensionVersionSchema,
    source: ExtensionSourceSchema,
    tool_ids: z.array(ExtensionIdSchema).readonly(),
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ToolProviderSchema = z
  .object({
    provider_id: ExtensionIdSchema,
    name: ExtensionNameSchema,
    source: ExtensionSourceSchema,
    tool_specs: z.array(ToolProviderToolSpecSchema).readonly(),
    requires_permission_check: z.boolean(),
    records_execution: z.boolean(),
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const HookPolicyHookTypeSchema = z.enum([
  "pre_tool_use",
  "post_tool_use",
  "stop"
]);

export const HookPolicyActionSchema = z.enum(["allow", "deny", "audit"]);

export const HookPolicySchema = z
  .object({
    policy_id: ExtensionIdSchema,
    hook_type: HookPolicyHookTypeSchema,
    target_pattern: ExtensionPatternSchema,
    action: HookPolicyActionSchema,
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const AgentProfileSchema = z
  .object({
    agent_id: ExtensionIdSchema,
    name: ExtensionNameSchema,
    capabilities: z.array(ExtensionIdSchema).readonly(),
    tool_access: z.array(ExtensionIdSchema).readonly(),
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const IntegrationDescriptorTypeSchema = z.enum([
  "mcp_server",
  "api_endpoint",
  "webhook",
  "file_system"
]);

export const IntegrationDescriptorStatusSchema = z.enum([
  "active",
  "inactive",
  "error"
]);

export const IntegrationDescriptorSchema = z
  .object({
    integration_id: ExtensionIdSchema,
    name: ExtensionNameSchema,
    integration_type: IntegrationDescriptorTypeSchema,
    endpoint: ExtensionEndpointSchema.optional(),
    status: IntegrationDescriptorStatusSchema,
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const McpServerTransportTypeSchema = z.enum(["stdio", "http"]);

export const McpServerInfoSchema = z
  .object({
    server_name: ExtensionIdSchema,
    transport_type: McpServerTransportTypeSchema,
    endpoint: ExtensionEndpointSchema.optional(),
    status: IntegrationDescriptorStatusSchema,
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type ExtensionSource = z.infer<typeof ExtensionSourceSchema>;
export type ExtensionDescriptorType = z.infer<typeof ExtensionDescriptorTypeSchema>;
export type ToolProviderToolSpec = z.infer<typeof ToolProviderToolSpecSchema>;
export type SkillPackage = z.infer<typeof SkillPackageSchema>;
export type ToolProvider = z.infer<typeof ToolProviderSchema>;
export type HookPolicyHookType = z.infer<typeof HookPolicyHookTypeSchema>;
export type HookPolicyAction = z.infer<typeof HookPolicyActionSchema>;
export type HookPolicy = z.infer<typeof HookPolicySchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type IntegrationDescriptorType = z.infer<typeof IntegrationDescriptorTypeSchema>;
export type IntegrationDescriptorStatus = z.infer<typeof IntegrationDescriptorStatusSchema>;
export type IntegrationDescriptor = z.infer<typeof IntegrationDescriptorSchema>;
export type McpServerTransportType = z.infer<typeof McpServerTransportTypeSchema>;
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

function isAllowedExtensionEndpoint(value: string): boolean {
  let endpoint: URL;

  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }

  if (endpoint.protocol === "https:") {
    return true;
  }

  if (endpoint.protocol !== "http:") {
    return false;
  }

  return isTrustedLocalHostname(endpoint.hostname);
}

function isTrustedLocalHostname(hostname: string): boolean {
  const normalizedHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1"
  );
}
