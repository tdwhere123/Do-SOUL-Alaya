const BELOW_TWENTY = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen"
] as const;
const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"
] as const;
const CJK_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

export function englishCardinal(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > 99) return null;
  if (value < 20) return BELOW_TWENTY[value] ?? null;
  const tens = TENS[Math.floor(value / 10)];
  const ones = value % 10;
  if (tens === undefined) return null;
  return ones === 0 ? tens : `${tens}-${BELOW_TWENTY[ones]}`;
}

export function cjkCardinal(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > 99) return null;
  if (value < 10) return CJK_DIGITS[value] ?? null;
  if (value === 10) return "十";
  if (value < 20) return `十${CJK_DIGITS[value % 10]}`;
  const ones = value % 10;
  return `${CJK_DIGITS[Math.floor(value / 10)]}十${ones === 0 ? "" : CJK_DIGITS[ones]}`;
}

export function numericAliasSurfaces(value: number, original: string): readonly string[] {
  const originalNormalized = original.normalize("NFKC").trim().toLowerCase();
  return Object.freeze([
    String(value),
    englishCardinal(value),
    ...cjkForms(value)
  ].filter((surface): surface is string =>
    surface !== null && surface.normalize("NFKC").trim().toLowerCase() !== originalNormalized
  ));
}

function cjkForms(value: number): readonly string[] {
  const canonical = cjkCardinal(value);
  if (canonical === null) return [];
  if (value === 0) return [canonical, "〇"];
  if (value === 2) return [canonical, "两"];
  return [canonical];
}
