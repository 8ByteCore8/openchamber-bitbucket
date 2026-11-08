import ar from './ar.ts';
import de from './de.ts';
import en, { type MessageKey, type Messages } from './en.ts';
import es from './es.ts';
import fr from './fr.ts';
import he from './he.ts';
import ja from './ja.ts';
import ko from './ko.ts';
import nl from './nl.ts';
import pl from './pl.ts';
import ptBR from './pt-BR.ts';
import ru from './ru.ts';
import tr from './tr.ts';
import uk from './uk.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

// The interface follows OpenChamber's language (`ready.locale`). The tags are
// OpenChamber's own interface languages; `ru` is kept for when the host
// reports a Russian locale. Anything else falls back to English.

export const DICTIONARIES: Record<string, Messages> = {
  en, de, fr, nl, 'zh-CN': zhCN, 'zh-TW': zhTW, uk, es, 'pt-BR': ptBR, ko, pl, ja, tr, ar, he, ru,
};

const RTL = new Set(['ar', 'he']);

let tag = 'en';
let messages: Messages = en;

/** The supported tag for a host locale: exact, then by prefix (`uk-UA`), then by base language. */
export const resolveLocale = (value: string | null | undefined): string => {
  if (!value) return 'en';
  if (DICTIONARIES[value]) return value;
  const normalized = value.toLowerCase().replace(/_/g, '-');
  const tags = Object.keys(DICTIONARIES);
  const exact = tags.find((candidate) => candidate.toLowerCase() === normalized || normalized.startsWith(`${candidate.toLowerCase()}-`));
  if (exact) return exact;
  const base = normalized.split('-')[0];
  if (base === 'zh') return normalized.includes('hant') || /-(tw|hk|mo)\b/.test(normalized) ? 'zh-TW' : 'zh-CN';
  if (base === 'pt') return 'pt-BR';
  return tags.find((candidate) => candidate.toLowerCase() === base) ?? 'en';
};

/** Switches the language; true when it changed. Also sets `lang` and `dir` on the page. */
export const setLocale = (value: string | null | undefined): boolean => {
  const next = resolveLocale(value);
  document.documentElement.lang = next;
  document.documentElement.dir = RTL.has(next) ? 'rtl' : 'ltr';
  if (next === tag) return false;
  tag = next;
  messages = DICTIONARIES[next] ?? en;
  return true;
};

export const locale = () => tag;

export const t = (key: MessageKey, params?: Record<string, string | number>): string => {
  const text = messages[key] ?? en[key];
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
};

/** Wraps text that must keep its own direction (branches, repository names) inside right-to-left sentences. */
export const isolate = (text: string) => `⁨${text}⁩`;

/** "5 minutes ago" in the current language. */
export const relativeTime = (iso: string) => {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'short' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12]];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return format.format(unit === 'second' ? 0 : value, unit === 'second' ? 'minute' : unit);
    value = Math.round(value / size);
  }
  return format.format(value, 'year');
};
