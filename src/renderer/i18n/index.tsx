import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UiLanguage } from '../../shared/types';

/**
 * Tiny i18n layer — no library, two languages, flat string keys.
 *
 * Every file under ./strings contributes a `{ uk, en }` bundle; Vite inlines
 * them at build time via import.meta.glob, so adding a component's strings
 * means adding a file, never touching this one. Keys are namespaced by the
 * component that owns them ("chatView.send", "sidebar.settings") so files
 * cannot clash.
 *
 * Usage in a component:
 *   const { t, locale } = useT();
 *   <button>{t('chatView.send')}</button>
 *   t('chatView.queued', { n: 3 })   // "{n}" placeholders
 *
 * Missing key in the active language → Ukrainian → the key itself, so a
 * half-translated build degrades visibly instead of crashing.
 */

export type Strings = Record<string, string>;
export type StringBundle = { uk: Strings; en: Strings };

const modules = import.meta.glob<{ default: StringBundle }>('./strings/*.ts', { eager: true });
const dict: StringBundle = { uk: {}, en: {} };
for (const m of Object.values(modules)) {
  Object.assign(dict.uk, m.default.uk);
  Object.assign(dict.en, m.default.en);
}

/** BCP-47 tags for Intl formatting (dates, numbers). */
export const LOCALES: Record<UiLanguage, string> = { uk: 'uk-UA', en: 'en-US' };

export type TFunction = (key: string, params?: Record<string, string | number>) => string;

export function translate(lang: UiLanguage, key: string, params?: Record<string, string | number>): string {
  let s = dict[lang]?.[key] ?? dict.uk[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** True when the key exists in the active language (or Ukrainian fallback).
 *  For lookup tables like tool labels, where a miss should show raw data. */
export function hasKey(lang: UiLanguage, key: string): boolean {
  return key in (dict[lang] ?? {}) || key in dict.uk;
}

export interface I18n {
  lang: UiLanguage;
  locale: string;
  t: TFunction;
  has: (key: string) => boolean;
}

const I18nContext = createContext<I18n>({
  lang: 'uk',
  locale: LOCALES.uk,
  t: (k, p) => translate('uk', k, p),
  has: (k) => hasKey('uk', k),
});

export function I18nProvider({ lang, children }: { lang: UiLanguage; children: ReactNode }) {
  const value = useMemo<I18n>(() => ({
    lang,
    locale: LOCALES[lang],
    t: (k, p) => translate(lang, k, p),
    has: (k) => hasKey(lang, k),
  }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18n {
  return useContext(I18nContext);
}
