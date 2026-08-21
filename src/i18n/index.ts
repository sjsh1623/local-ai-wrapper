import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));

function load(locale: Locale): Record<string, string> {
  return JSON.parse(readFileSync(join(here, 'locales', `${locale}.json`), 'utf8'));
}

const CATALOGS: Record<Locale, Record<string, string>> = {
  ko: load('ko'),
  en: load('en'),
};

const warned = new Set<string>();

/**
 * Look up `key` in `locale`, falling back to English so a missing translation
 * degrades to readable text instead of a raw key. Params are `{name}` slots.
 */
export function t(
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string {
  let template = CATALOGS[locale]?.[key];
  if (template === undefined) {
    template = CATALOGS.en[key];
    const id = `${locale}:${key}`;
    if (template !== undefined && !warned.has(id)) {
      warned.add(id);
      process.stderr.write(`[i18n] missing key ${id}, using English\n`);
    }
  }
  if (template === undefined) return key;

  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

export function stageLabel(locale: Locale, stage: string): string {
  return t(locale, `stage.${stage}`);
}
