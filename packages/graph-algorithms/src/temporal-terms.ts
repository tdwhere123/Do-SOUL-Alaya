const ENGLISH_MONTH_SOURCE =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const RELATIVE_COUNT_SOURCE =
  "(?:(?:a\\s+)?couple\\s+of|an?|\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

const TEMPORAL_TERM_PATTERN = new RegExp([
  String.raw`\b\d{4}-\d{2}(?:-\d{2})?\b`,
  String.raw`\b(?:\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b`,
  String.raw`\b${ENGLISH_MONTH_SOURCE}\s+\d{4}\b`,
  String.raw`\b(?:in\s+(?:the\s+month\s+of\s+)?|(?:the\s+)?month\s+of\s+)${ENGLISH_MONTH_SOURCE}\b(?!\s+\d{4}\b)`,
  String.raw`\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?`,
  String.raw`(?<![\p{L}\p{N}_-])\d{4}(?![\p{L}\p{N}_-])`,
  String.raw`\b(?:today|yesterday|tomorrow|tonight|last\s+(?:week|month|year)|next\s+(?:week|month|year)|this\s+(?:week|month|year)|(?:last|this|next)\s+(?:spring|summer|autumn|fall|winter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:past|last)\s+${RELATIVE_COUNT_SOURCE}\s+(?:days?|weeks?|months?|years?)|${RELATIVE_COUNT_SOURCE}\s+(?:days?|weeks?|months?|years?)\s+ago)\b`,
  String.raw`(?:上次|昨天|今天|明天|今晚|上周|上个月|去年|下周|下个月|明年|今年|\d{1,3}(?:天|周|个月|年)前)`
].join("|"), "giu");

export function extractTemporalTerms(text: string): readonly string[] {
  const terms = [...text.matchAll(TEMPORAL_TERM_PATTERN)].map((match) => match[0].trim());
  return [...new Set(terms)].slice(0, 64);
}
