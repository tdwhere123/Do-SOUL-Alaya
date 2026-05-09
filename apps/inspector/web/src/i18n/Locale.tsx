import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { dictionaries, type DictKey, type Locale } from "./dict";

interface LocaleContextValue {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  readonly t: (key: DictKey, params?: Record<string, string | number>) => string;
}

const STORAGE_KEY = "alaya-inspector-locale";
const DEFAULT_LOCALE: Locale = "zh";

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    /* localStorage may be blocked in some embed contexts; fall through. */
  }
  const nav = window.navigator?.language?.toLowerCase() ?? "";
  if (nav.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

// Default consumer when no <LocaleProvider> wraps the tree. Production always
// wraps via App.tsx, where DEFAULT_LOCALE / detectInitialLocale apply; this
// fallback only fires for unit tests that mount sub-components directly. Use
// `en` so existing English-string assertions stay valid without forcing every
// test to mount a provider.
const FALLBACK_LOCALE: Locale = "en";
const FALLBACK_VALUE: LocaleContextValue = {
  locale: FALLBACK_LOCALE,
  setLocale: () => undefined,
  t: (key, params) => {
    const template = dictionaries[FALLBACK_LOCALE][key] ?? dictionaries.en[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : `{${name}}`
    );
  }
};
const LocaleContext = createContext<LocaleContextValue>(FALLBACK_VALUE);

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale());

  useEffect(() => {
    try {
      window.localStorage?.setItem(STORAGE_KEY, locale);
    } catch {
      /* see detectInitialLocale */
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);

  const t = useCallback(
    (key: DictKey, params?: Record<string, string | number>): string => {
      const dict = dictionaries[locale];
      const template = dict[key] ?? dictionaries.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name)
          ? String(params[name])
          : `{${name}}`
      );
    },
    [locale]
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n(): LocaleContextValue {
  return useContext(LocaleContext);
}
