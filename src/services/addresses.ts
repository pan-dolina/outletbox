import { isValidEmail, normalizeEmail } from '../crypto.js';
import { isLang, type Lang, type MessageKey } from '../i18n.js';

/** One person a link (or a group) is meant for. */
export interface RecipientInput { email: string; lang: Lang }

/** Upper bound on addresses per link and per group: each one can trigger code e-mails. */
export const MAX_RECIPIENTS = 100;

/**
 * A problem with an address list the administrator typed. Carries a message key
 * rather than English text, because the panel shows it in the admin's language.
 */
export class RecipientListError extends Error {
  constructor(public readonly key: MessageKey, public readonly params: Record<string, string | number> = {}) {
    super(key);
    this.name = 'RecipientListError';
  }
}

/**
 * Reads the free-form address list from the panel. Accepted, and freely mixed:
 *
 *   jan@example.com
 *   anna@example.com de                    ← a language code after the address
 *   Jan Kowalski <jan@example.com>; …      ← a list pasted from a mail client
 *   "Kowalski, Jan" <jan@example.com>      ← quoted display names may hold commas
 *
 * Entries are separated by new lines, commas or semicolons. Words before the
 * address are a display name and ignored; after it only a language code may
 * follow — anything else is reported rather than guessed at, since a silently
 * dropped typo would lock a person out of their delivery.
 */
export function parseRecipients(text: string, defaultLang: Lang): { recipients: RecipientInput[]; invalid: string[] } {
  const recipients: RecipientInput[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  // Display names in quotes are dropped first, so their commas do not split an entry.
  const entries = text.replace(/"[^"\n]*"/g, ' ').split(/[\n\r,;]+/);
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const parsed = parseEntry(entry, defaultLang);
    if (!parsed) {
      invalid.push(entry.slice(0, 80));
      continue;
    }
    if (seen.has(parsed.email)) continue;
    seen.add(parsed.email);
    recipients.push(parsed);
  }
  return { recipients, invalid };
}

function parseEntry(entry: string, defaultLang: Lang): RecipientInput | null {
  let address: string;
  let tail: string[];
  const angle = /<([^<>]*)>/.exec(entry);
  if (angle) {
    address = angle[1]!;
    tail = entry.slice(angle.index + angle[0].length).split(/\s+/).filter(Boolean);
  } else {
    const words = entry.split(/\s+/);
    const at = words.findIndex((w) => w.includes('@'));
    if (at < 0) return null;
    address = words[at]!;
    tail = words.slice(at + 1);
  }
  const email = normalizeEmail(address);
  if (!isValidEmail(email)) return null;
  if (tail.length > 1) return null;
  if (tail.length === 0) return { email, lang: defaultLang };
  const code = tail[0]!.toLowerCase();
  return isLang(code) ? { email, lang: code } : null;
}

/**
 * Parses and validates in one go: the list must hold at least one address, no
 * unreadable entries and no more than MAX_RECIPIENTS people.
 */
export function requireRecipients(text: string, defaultLang: Lang, extra: RecipientInput[] = []): RecipientInput[] {
  const { recipients, invalid } = parseRecipients(text, defaultLang);
  if (invalid.length) throw new RecipientListError('recipients.invalid', { list: invalid.join(' · ') });
  const merged = mergeRecipients(recipients, extra);
  if (merged.length === 0) throw new RecipientListError('recipients.none');
  if (merged.length > MAX_RECIPIENTS) throw new RecipientListError('recipients.too_many', { max: MAX_RECIPIENTS });
  return merged;
}

/** Union by address; the first occurrence (and its language) wins. */
export function mergeRecipients(...lists: RecipientInput[][]): RecipientInput[] {
  const out: RecipientInput[] = [];
  const seen = new Set<string>();
  for (const r of lists.flat()) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    out.push(r);
  }
  return out;
}

/** The inverse of parseRecipients: one "address lang" per line, so it round-trips through a textarea. */
export function formatRecipients(list: readonly RecipientInput[]): string {
  return list.map((r) => `${r.email} ${r.lang}`).join('\n');
}
