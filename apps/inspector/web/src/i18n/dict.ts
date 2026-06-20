import { en } from "./dict-en";
import { zh, type Locale } from "./dict-zh";

export type { Locale };
export type DictKey = keyof typeof zh;

export { en, zh };

export const dictionaries: Record<Locale, Record<DictKey, string>> = {
  zh,
  en
};
