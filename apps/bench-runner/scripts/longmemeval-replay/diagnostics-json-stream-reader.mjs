import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

const DEFAULT_MAX_QUESTION_CHARS = 128 * 1024 * 1024;
const MAX_METADATA_CHARS = 16 * 1024 * 1024;
const MAX_KEY_CHARS = 1024;

export class DiagnosticsJsonStreamReader {
  #metadata = Object.create(null);
  #questions = [];
  #state = "start";
  #key = "";
  #keyRaw = "";
  #buffer = "";
  #scan = null;
  #questionsSeen = false;
  #questionCount = 0;
  #afterComma = false;

  constructor(options = {}) {
    const max = options.maxQuestionChars ?? DEFAULT_MAX_QUESTION_CHARS;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error("diagnostics maxQuestionChars must be a positive integer");
    }
    this.maxQuestionChars = max;
    this.collectQuestions = options.collectQuestions !== false;
    this.onQuestion = options.onQuestion;
  }

  consume(chunk) {
    let captureStart = this.#isCapturing() ? 0 : -1;
    for (let index = 0; index < chunk.length; index += 1) {
      const wasCapturing = captureStart >= 0;
      const consumed = this.#consumeChar(chunk[index] ?? "");
      const isCapturing = this.#isCapturing();
      if (wasCapturing && !isCapturing) {
        this.#appendCaptured(chunk.slice(captureStart, index + (consumed ? 1 : 0)));
        captureStart = -1;
        this.#finishCapturedValue();
      }
      if (!wasCapturing && isCapturing) captureStart = index;
      if (!consumed) index -= 1;
    }
    if (captureStart >= 0) this.#appendCaptured(chunk.slice(captureStart));
  }

  finish() {
    if (this.#state !== "done") {
      throw new Error(`truncated diagnostics JSON in state ${this.#state}`);
    }
    if (!this.#questionsSeen) throw new Error("diagnostics JSON missing questions array");
    if (this.#metadata.schema_version !== 1) {
      throw new Error("diagnostics JSON has invalid schema_version");
    }
    return { ...this.#metadata, questions: this.#questions };
  }

  #consumeChar(char) {
    if (this.#state === "start") return this.#consumeStart(char);
    if (this.#state === "key_or_end") return this.#consumeKeyStart(char);
    if (this.#state === "key") return this.#consumeKey(char);
    if (this.#state === "colon") return this.#consumeColon(char);
    if (this.#state === "value_start") return this.#consumeValueStart(char);
    if (this.#state === "metadata_value") return this.#consumeMetadata(char);
    if (this.#state === "questions_start") return this.#consumeQuestionStart(char);
    if (this.#state === "question_value") return this.#consumeQuestion(char);
    if (this.#state === "question_separator") return this.#consumeQuestionSeparator(char);
    if (this.#state === "after_value") return this.#consumeAfterValue(char);
    if (!isWhitespace(char)) throw new Error("trailing garbage after diagnostics JSON");
    return true;
  }

  #consumeStart(char) {
    if (isWhitespace(char)) return true;
    if (char !== "{") throw new Error("diagnostics JSON must be a top-level object");
    this.#state = "key_or_end";
    return true;
  }

  #consumeKeyStart(char) {
    if (isWhitespace(char)) return true;
    if (char === "}" && !this.#afterComma) {
      this.#state = "done";
      return true;
    }
    if (char !== "\"") throw new Error("diagnostics JSON expected a property name");
    this.#keyRaw = "\"";
    this.#scan = startValueScan(char);
    this.#state = "key";
    return true;
  }

  #consumeKey(char) {
    this.#keyRaw += char;
    if (this.#keyRaw.length > MAX_KEY_CHARS) {
      throw new Error("diagnostics property name is too large");
    }
    acceptValueChar(this.#requiredScan(), char);
    if (!this.#requiredScan().complete) return true;
    this.#key = parseJson(this.#keyRaw, "diagnostics property name");
    if (Object.hasOwn(this.#metadata, this.#key) ||
        (this.#key === "questions" && this.#questionsSeen)) {
      throw new Error(`duplicate diagnostics property ${this.#key}`);
    }
    this.#scan = null;
    this.#state = "colon";
    return true;
  }

  #consumeColon(char) {
    if (isWhitespace(char)) return true;
    if (char !== ":") throw new Error(`diagnostics property ${this.#key} missing colon`);
    this.#state = "value_start";
    return true;
  }

  #consumeValueStart(char) {
    if (isWhitespace(char)) return true;
    if (this.#key === "questions") {
      if (char !== "[") throw new Error("diagnostics questions must be an array");
      this.#questionsSeen = true;
      this.#afterComma = false;
      this.#state = "questions_start";
      return true;
    }
    this.#scan = startValueScan(char);
    this.#state = "metadata_value";
    return true;
  }

  #consumeMetadata(char) {
    const scan = this.#requiredScan();
    if (scan.complete) {
      if (isWhitespace(char)) return true;
      if (char === "," || char === "}") return false;
      throw new Error(`invalid trailing data in diagnostics property ${this.#key}`);
    }
    if (scan.depth === 0 && !scan.inString && (char === "," || char === "}")) {
      scan.complete = true;
      return false;
    }
    acceptValueChar(scan, char);
    return true;
  }

  #consumeQuestionStart(char) {
    if (isWhitespace(char)) return true;
    if (char === "]" && !this.#afterComma) {
      this.#state = "after_value";
      return true;
    }
    if (char !== "{") throw new Error("diagnostics questions entries must be objects");
    this.#scan = startValueScan(char);
    this.#state = "question_value";
    return true;
  }

  #consumeQuestion(char) {
    acceptValueChar(this.#requiredScan(), char);
    return true;
  }

  #consumeQuestionSeparator(char) {
    if (isWhitespace(char)) return true;
    if (char === ",") {
      this.#afterComma = true;
      this.#state = "questions_start";
      return true;
    }
    if (char === "]") {
      this.#afterComma = false;
      this.#state = "after_value";
      return true;
    }
    throw new Error("diagnostics questions expected comma or closing bracket");
  }

  #consumeAfterValue(char) {
    if (isWhitespace(char)) return true;
    if (char === ",") {
      this.#afterComma = true;
      this.#state = "key_or_end";
      return true;
    }
    if (char === "}") {
      this.#afterComma = false;
      this.#state = "done";
      return true;
    }
    throw new Error("diagnostics JSON expected comma or closing object");
  }

  #isCapturing() {
    return (this.#state === "metadata_value" || this.#state === "question_value") &&
      this.#scan?.complete !== true;
  }

  #appendCaptured(fragment) {
    this.#buffer += fragment;
    const limit = this.#state === "question_value"
      ? this.maxQuestionChars
      : MAX_METADATA_CHARS;
    if (this.#buffer.length > limit) {
      const kind = this.#state === "question_value" ? "question" : "metadata property";
      throw new Error(`diagnostics ${kind} exceeds ${limit} characters`);
    }
  }

  #finishCapturedValue() {
    if (this.#state === "metadata_value") {
      this.#metadata[this.#key] = parseJson(
        this.#buffer.trimEnd(), `diagnostics property ${this.#key}`
      );
      this.#state = "after_value";
    } else if (this.#state === "question_value") {
      const index = this.#questionCount;
      const question = parseJson(this.#buffer, `diagnostics question[${index}]`);
      requireQuestionObject(question, index);
      if (this.collectQuestions) this.#questions.push(question);
      if (typeof this.onQuestion === "function") this.onQuestion(question, index);
      this.#questionCount += 1;
      this.#state = "question_separator";
    }
    this.#buffer = "";
    this.#scan = null;
  }

  #requiredScan() {
    if (this.#scan === null) throw new Error("diagnostics parser lost value state");
    return this.#scan;
  }
}

export async function readDiagnosticsJsonStream(artifactPath, options = {}) {
  const source = createReadStream(artifactPath);
  const gunzip = options.gzip === true ? createGunzip() : null;
  if (gunzip !== null) source.once("error", (error) => gunzip.destroy(error));
  const input = gunzip === null ? source : source.pipe(gunzip);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = new DiagnosticsJsonStreamReader(options);
  try {
    for await (const chunk of input) {
      const decoded = decoder.decode(chunk, { stream: true });
      if (decoded.length > 0) reader.consume(decoded);
    }
    const tail = decoder.decode();
    if (tail.length > 0) reader.consume(tail);
    return reader.finish();
  } catch (error) {
    source.destroy();
    input.destroy();
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = /utf-8/iu.test(rawMessage) ? `invalid UTF-8: ${rawMessage}` : rawMessage;
    throw new Error(`failed to read diagnostics ${artifactPath}: ${message}`, { cause: error });
  }
}

function startValueScan(char) {
  if (char === "\"") return { depth: 0, inString: true, escaped: false, complete: false };
  if (char === "{" || char === "[") {
    return { depth: 1, inString: false, escaped: false, complete: false };
  }
  return { depth: 0, inString: false, escaped: false, complete: false };
}

function acceptValueChar(scan, char) {
  if (scan.inString) {
    if (scan.escaped) scan.escaped = false;
    else if (char === "\\") scan.escaped = true;
    else if (char === "\"") {
      scan.inString = false;
      if (scan.depth === 0) scan.complete = true;
    }
    return;
  }
  if (char === "\"") scan.inString = true;
  else if (char === "{" || char === "[") scan.depth += 1;
  else if (char === "}" || char === "]") {
    scan.depth -= 1;
    if (scan.depth < 0) throw new Error("diagnostics JSON has mismatched brackets");
    if (scan.depth === 0) scan.complete = true;
  }
}

function requireQuestionObject(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`diagnostics question[${index}] must be an object`);
  }
}

function parseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context} is malformed JSON: ${message}`);
  }
}

function isWhitespace(char) {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}
