import { FACET_VOCABULARY } from "./memory-entry.js";

// Shared answer-relevance ontology bridge: one keyword table maps free text to
// FACET_VOCABULARY ids so write-side entry facets and read-side query facets are
// drawn from the same vocabulary and can overlap deterministically.
const FACET_KEYWORD_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["occupation_work", /\b(job|work|career|profession|occupation|employer|company|工作|职业|公司)\b/iu],
  ["education", /\b(school|college|university|degree|study|studied|major|学校|大学|学位|专业)\b/iu],
  ["location_place", /\b(where|live|lives?|location|city|country|address|住|地点|城市|国家)\b/iu],
  ["event_activity", /\b(event|activity|attend|meeting|party|conference|活动|会议|聚会)\b/iu],
  ["time_date", /\b(when|date|time|year|month|day|yesterday|today|时间|日期|什么时候)\b/iu],
  ["preference_like", /\b(prefer|preference|like|likes?|favorite|enjoy|偏好|喜欢|最爱)\b/iu],
  ["possession_item", /\b(own|owns?|has|have|possess|belongings?|拥有|有)\b/iu],
  ["relationship_person", /\b(friend|family|partner|spouse|colleague|relationship|朋友|家人|同事|关系)\b/iu],
  ["health", /\b(health|sick|illness|doctor|medical|condition|健康|生病|医生)\b/iu],
  ["finance_money", /\b(money|salary|income|finance|budget|cost|price|钱|收入|预算|价格)\b/iu],
  ["travel", /\b(travel|trip|flight|vacation|visit|abroad|旅行|出差|旅游)\b/iu],
  ["food_dining", /\b(food|eat|ate|restaurant|meal|cuisine|dining|食物|吃|餐厅)\b/iu],
  ["hobby_skill", /\b(hobby|skill|play|sport|instrument|practice|爱好|技能|运动)\b/iu],
  ["purchase", /\b(buy|bought|purchase|order|ordered|shopping|买|购买|下单)\b/iu],
  ["media_entertainment", /\b(movie|film|show|music|book|game|watch|read|电影|音乐|书|游戏)\b/iu],
  ["life_event", /\b(born|married|moved|graduated|retired|divorce|出生|结婚|搬家|毕业)\b/iu],
  ["communication_tool", /\b(email|phone|message|chat|call|slack|whatsapp|邮件|电话|消息)\b/iu]
];

const ACTIVE_FACET_KEYWORD_PATTERNS = FACET_KEYWORD_PATTERNS.filter(
  ([facet]) => FACET_VOCABULARY.includes(facet)
);

export function deriveFacetsFromText(text: string): readonly string[] {
  if (text.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(
    ACTIVE_FACET_KEYWORD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([facet]) => facet)
  );
}
