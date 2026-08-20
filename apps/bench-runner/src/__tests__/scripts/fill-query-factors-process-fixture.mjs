import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const mode = process.env.QUERY_FACTOR_PROCESS_MODE;
const requestPath = process.env.QUERY_FACTOR_REQUEST_PATH;
const scriptPath = process.env.QUERY_FACTOR_SCRIPT_PATH;
if (mode === undefined || requestPath === undefined || scriptPath === undefined) {
  throw new Error("query factor process fixture is not configured");
}

globalThis.fetch = async (url, init) => {
  await writeFile(requestPath, JSON.stringify({ url: String(url), body: init?.body }), "utf8");
  if (mode === "provider-error") {
    return new Response(JSON.stringify({ error: { message: "terminal fixture failure" } }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(validQueryResponse()) },
      finish_reason: "stop" }]
  }), { status: 200, headers: { "content-type": "application/json" } });
};

await import(`${pathToFileURL(scriptPath).href}?fixture=${Date.now()}`);

function validQueryResponse() {
  return { semantic_factor_graph: {
    schema_version: 2,
    source_kind: "query",
    factors: [
      { factor_id: "predicate", surface: "buy", semantic_identity: "buy" },
      { factor_id: "subject", surface: "I", semantic_identity: "i" }
    ],
    variables: [{ variable_id: "answer", surface: "What" }],
    result_variable_ids: ["answer"],
    propositions: [{ proposition_id: "query", predicate_factor_id: "predicate",
      arguments: [
        { position: 0, binding_identity: "agent", reference_kind: "factor",
          reference_id: "subject" },
        { position: 1, binding_identity: "object", reference_kind: "variable",
          reference_id: "answer" }
      ] }]
  } };
}
