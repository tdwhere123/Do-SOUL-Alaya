import { z } from "zod";
import { OfficialApiSourcePacketResponseSchema } from "./source-packet-receive.js";
import { parseOfficialApiSourcePacketRequest, type OfficialApiSourcePacketRequest } from "./source-packet-request.js";

/** Provider constraints and local admission consume the same request-bound vocabulary. */
export function officialApiSourcePacketResponseSchema(requestValue: OfficialApiSourcePacketRequest): object {
  const request = parseOfficialApiSourcePacketRequest(requestValue);
  const schema = z.toJSONSchema(OfficialApiSourcePacketResponseSchema, { io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    } });
  const constrain = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(constrain);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== "properties" || item === null || typeof item !== "object") return [key, constrain(item)];
      return [key, Object.fromEntries(Object.entries(item).map(([name, definition]) => {
        const symbols = name === "predicate" ? request.profile.predicates.map((row) => row.symbol) :
          name === "role" ? request.profile.roles.map((row) => row.symbol) : name === "profile_id" ? [request.profile_id] :
          name === "source_catalog_id" ? [request.source_catalog.catalog_id] : null;
        return [name, symbols === null ? constrain(definition) : { type: "string", enum: symbols }];
      }))];
    }));
  };
  return constrain(schema) as object;
}
