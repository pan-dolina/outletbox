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
 * The one and only message this application sends. It deliberately does not
 * carry the delivery link: an administrator hands that over out of band, so a
 * forwarded or intercepted message is useless on its own.
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
