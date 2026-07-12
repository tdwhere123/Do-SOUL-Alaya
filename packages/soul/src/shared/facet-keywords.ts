import { FACET_VOCABULARY } from "@do-soul/alaya-protocol";

// invariant: this keyword table mirrors packages/core/src/recall/expansion/facet-keywords.ts.
// Both sides emit FACET_VOCABULARY ids so write-side entry facets and read-side
// query facets can overlap deterministically without a core<->soul dependency.
type FacetKeywordPattern = Readonly<{ readonly facet: string; readonly ascii: RegExp; readonly cjk: RegExp }>;

const FACET_KEYWORD_PATTERNS: readonly FacetKeywordPattern[] = [
  { facet: "occupation_work", ascii: /\b(job|work|career|profession|occupation|employer|company)\b/iu, cjk: /工作|职业|公司/iu },
  { facet: "education", ascii: /\b(school|college|university|degree|study|studied|major)\b/iu, cjk: /学校|大学|学位|专业/iu },
  { facet: "location_place", ascii: /\b(where|live|lives?|location|city|country|address)\b/iu, cjk: /住|地点|城市|国家/iu },
  { facet: "event_activity", ascii: /\b(event|activity|attend|meeting|party|conference)\b/iu, cjk: /活动|会议|聚会/iu },
  { facet: "time_date", ascii: /\b(when|date|time|year|month|day|yesterday|today)\b/iu, cjk: /时间|日期|什么时候/iu },
  { facet: "preference_like", ascii: /\b(prefer|preference|like|likes?|favorite|enjoy)\b/iu, cjk: /偏好|喜欢|最爱/iu },
  { facet: "possession_item", ascii: /\b(own|owns?|has|have|possess|belongings?)\b/iu, cjk: /拥有|持有|属于(?:我|你|他|她|它|我们|你们|他们|她们|它们|本人)|归(?:我|你|他|她|它|我们|你们|他们|她们|它们|本人)所有|(?:我|你|他|她|它|我们|你们|他们|她们|它们|本人)有(?!(?:关|时|点|些|效|限|趣|名|序|误|害|用|利|必要))(?=[\p{Script=Han}\d])/iu },
  { facet: "health", ascii: /\b(health|sick|illness|doctor|medical|condition)\b/iu, cjk: /健康|生病|医生/iu },
  { facet: "finance_money", ascii: /\b(money|salary|income|finance|budget|cost|price)\b/iu, cjk: /钱|收入|预算|价格/iu },
  { facet: "travel", ascii: /\b(travel|trip|flight|vacation|visit|abroad)\b/iu, cjk: /旅行|出差|旅游/iu },
  { facet: "food_dining", ascii: /\b(food|eat|ate|restaurant|meal|cuisine|dining)\b/iu, cjk: /食物|吃|餐厅/iu },
  { facet: "hobby_skill", ascii: /\b(hobby|skill|play|sport|instrument|practice)\b/iu, cjk: /爱好|技能|运动/iu },
  { facet: "purchase", ascii: /\b(buy|bought|purchase|order|ordered|shopping)\b/iu, cjk: /买|购买|下单/iu },
  { facet: "media_entertainment", ascii: /\b(movie|film|show|music|book|game|watch|read)\b/iu, cjk: /电影|音乐|书|游戏/iu },
  { facet: "life_event", ascii: /\b(born|married|moved|graduated|retired|divorce)\b/iu, cjk: /出生|结婚|搬家|毕业/iu },
  { facet: "communication_tool", ascii: /\b(email|phone|message|chat|call|slack|whatsapp)\b/iu, cjk: /邮件|电话|消息/iu }
];

const ACTIVE_FACET_KEYWORD_PATTERNS = FACET_KEYWORD_PATTERNS.filter(
  ({ facet }) => FACET_VOCABULARY.includes(facet)
);

const PERSONAL_RELATIONSHIP_PATTERN =
  /\b(relative|relatives|family|kinship|parent|parents|mother|father|sibling|siblings|brother|sister|spouse|husband|wife|aunt|uncle|cousin|friend|colleague|relationship)\b|(?:亲属|亲戚|家人|父母|母亲|父亲|兄弟|姐妹|配偶|丈夫|妻子|朋友|同事|关系)/iu;
const PARTNER_PATTERN = /\bpartners?\b/iu;
const NON_PERSONAL_PARTNER_PATTERN =
  /\b(business|commercial|company|corporate|integration|technology|trading|channel|project|vendor|platform)\s+partners?\b|\bpartners?\s+(?:company|integration|platform|vendor)\b/iu;

export function deriveFacetsFromText(text: string): readonly string[] {
  if (text.length === 0) {
    return Object.freeze([]);
  }
  const facets = ACTIVE_FACET_KEYWORD_PATTERNS
    .filter(({ ascii, cjk }) => ascii.test(text) || cjk.test(text))
    .map(({ facet }) => facet);
  if (hasPersonalRelationshipConcept(text)) {
    facets.push("relationship_person");
  }
  return Object.freeze(facets);
}

function hasPersonalRelationshipConcept(text: string): boolean {
  if (PERSONAL_RELATIONSHIP_PATTERN.test(text)) {
    return true;
  }
  return PARTNER_PATTERN.test(text) && !NON_PERSONAL_PARTNER_PATTERN.test(text);
}
