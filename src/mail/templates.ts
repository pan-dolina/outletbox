import { t, type Lang } from '../i18n.js';
import { assertSafeHeader, type OutgoingMail } from './types.js';

/** Local, dependency-free escaping: these bodies never contain markup we did not write. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function htmlDocument(brand: string, paragraphs: string[]): string {
  return [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#101418">',
    '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:24px">',
    `<p style="margin:0 0 16px;font-weight:600;font-size:15px">${esc(brand)}</p>`,
    ...paragraphs,
    '</div></body></html>',
  ].join('');
}

export interface CodeMailInput {
  lang: Lang;
  to: string;
  brand: string;
  caseName: string;
  code: string;
  ttlMinutes: number;
}

/**
 * The one-time code. It deliberately does not repeat the delivery link: the
 * code alone is useless without it, which keeps a forwarded message harmless.
 */
export function accessCodeMail(input: CodeMailInput): OutgoingMail {
  const tr = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t(input.lang, key, params);
  const subject = assertSafeHeader(tr('mail.code.subject', { code: input.code }), 'subject');
  const lines = [
    tr('mail.code.greeting'),
    '',
    tr('mail.code.intro', { case: input.caseName, brand: input.brand }),
    '',
    tr('mail.code.code_line', { code: input.code }),
    tr('mail.code.validity', { minutes: input.ttlMinutes }),
    '',
    tr('mail.code.ignore'),
    '',
    '--',
    tr('mail.code.footer', { brand: input.brand }),
  ];
  const html = htmlDocument(input.brand, [
    `<p style="margin:0 0 12px">${esc(tr('mail.code.greeting'))}</p>`,
    `<p style="margin:0 0 16px">${esc(tr('mail.code.intro', { case: input.caseName, brand: input.brand }))}</p>`,
    `<p style="margin:0 0 8px;font-size:28px;letter-spacing:6px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Consolas,monospace">${esc(input.code)}</p>`,
    `<p style="margin:0 0 16px;color:#5b6472;font-size:13px">${esc(tr('mail.code.validity', { minutes: input.ttlMinutes }))}</p>`,
    `<p style="margin:0 0 16px;font-size:13px">${esc(tr('mail.code.ignore'))}</p>`,
    `<p style="margin:0;color:#8a919c;font-size:12px">${esc(tr('mail.code.footer', { brand: input.brand }))}</p>`,
  ]);
  return { to: input.to, subject, text: lines.join('\n'), html };
}

export interface LinkMailInput {
  lang: Lang;
  to: string;
  brand: string;
  caseName: string;
  url: string;
  expiresAt?: string | null;
}

/** Optional: the panel can hand the link itself to the recipient over the same channel. */
export function deliveryLinkMail(input: LinkMailInput): OutgoingMail {
  const tr = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t(input.lang, key, params);
  const subject = assertSafeHeader(tr('mail.link.subject', { case: input.caseName }), 'subject');
  const expires = input.expiresAt ? tr('mail.link.expires', { date: input.expiresAt.replace('T', ' ').slice(0, 16) }) : '';
  const lines = [
    tr('mail.code.greeting'),
    '',
    tr('mail.link.intro', { brand: input.brand, case: input.caseName }),
    '',
    tr('mail.link.link_line', { url: input.url }),
    '',
    tr('mail.link.howto', { email: input.to }),
    ...(expires ? ['', expires] : []),
    '',
    '--',
    tr('mail.code.footer', { brand: input.brand }),
  ];
  const html = htmlDocument(input.brand, [
    `<p style="margin:0 0 12px">${esc(tr('mail.code.greeting'))}</p>`,
    `<p style="margin:0 0 16px">${esc(tr('mail.link.intro', { brand: input.brand, case: input.caseName }))}</p>`,
    `<p style="margin:0 0 16px"><a href="${esc(input.url)}" style="display:inline-block;padding:10px 18px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">${esc(tr('deliver.package.title'))}</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;word-break:break-all">${esc(input.url)}</p>`,
    `<p style="margin:0 0 16px;font-size:13px">${esc(tr('mail.link.howto', { email: input.to }))}</p>`,
    ...(expires ? [`<p style="margin:0 0 16px;color:#5b6472;font-size:13px">${esc(expires)}</p>`] : []),
    `<p style="margin:0;color:#8a919c;font-size:12px">${esc(tr('mail.code.footer', { brand: input.brand }))}</p>`,
  ]);
  return { to: input.to, subject, text: lines.join('\n'), html };
}
