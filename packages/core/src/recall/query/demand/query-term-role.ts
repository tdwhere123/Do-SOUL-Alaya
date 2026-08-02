const QUERY_OPERATOR_TERMS = new Set([
  "about", "again", "also", "am", "amount", "any", "are", "back", "be",
  "been", "being", "but", "can", "chat", "confirm", "could", "current", "day",
  "days", "did", "different", "distinct", "do", "does", "during", "earliest",
  "favorite", "favourite", "first", "from", "get", "getting", "have", "hour",
  "hours", "how", "idea", "into", "last", "latest", "local", "long", "looking",
  "many", "may", "might", "minute", "minutes", "money", "month", "months", "most",
  "much", "new", "not", "one", "order", "planning", "please", "previous", "really",
  "recently", "remind", "second", "seconds", "should", "some", "specific", "sure",
  "that", "their", "there", "these", "they", "think", "thinking", "this", "those",
  "times", "total", "unique", "upcoming", "want", "wanted", "was", "week", "weeks",
  "were", "what", "when", "where", "which", "while", "will", "with", "would",
  "year", "years", "your"
]);

const QUERY_RELATION_TERMS = new Set([
  "ask", "asked", "assemble", "assembled", "attend", "attended", "bought",
  "buy", "choose", "chose", "collect", "collected", "complete", "completed",
  "cost", "costs", "decide", "decided", "gave", "give", "have", "learn",
  "learned", "like", "liked", "live", "lived", "marinate", "marinated", "meet",
  "mention", "mentioned", "met", "move", "moved", "own", "paid", "pay", "play",
  "prefer", "preferred", "provide", "provided", "recommend", "recommended",
  "redeem", "redeemed", "say", "said", "share", "shared", "spend", "spent",
  "suggest", "suggested", "take", "tell", "told", "took", "travel", "traveled",
  "use", "used", "visit", "visited", "wait", "waited", "watch", "watched"
]);

export function isRecallQueryOperatorTerm(term: string): boolean {
  return QUERY_OPERATOR_TERMS.has(term);
}

export function isRecallQueryRelationTerm(term: string): boolean {
  return QUERY_RELATION_TERMS.has(term);
}
