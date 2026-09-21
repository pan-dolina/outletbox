import type { Brand } from '../config.js';
import { t, type Lang } from '../i18n.js';
import { assertSafeHeader, type OutgoingMail } from './types.js';

/** Local, dependency-free escaping: these bodies never contain markup we did not write. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/**
 * The message wears the instance's own branding: the logo and the top-bar
 * colour the recipient has already seen on the delivery page, so the mail with
 * the code and the page asking for it look like the same thing.
 *
 * Built as a table with inline styles because that is what mail clients render
 * predictably — no stylesheet, no flexbox, no custom properties. The colours
 * come from the configuration, where they are validated as hex, and everything
 * else is escaped.
 */
function htmlDocument(brand: Brand, logoUrl: string | null, paragraphs: string[]): string {
  const header = logoUrl
    // The image is likely to be blocked, so the alt text has to work on its own:
    // white, because it sits on the dark band where the logo would be.
    ? `<img src="${esc(logoUrl)}" alt="${esc(brand.name)}" height="28" style="height:28px;max-width:220px;display:block;border:0;color:#ffffff;font-weight:600;font-size:16px">`
    : `<span style="color:#ffffff;font-weight:600;font-size:16px">${esc(brand.name)}</span>`;
  return [
    // The charset belongs in the document as well as in the MIME headers: a
    // webmail client that lifts this part out of the message has nothing else
    // to go by, and Polish text falls apart without it.
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#101418">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ea;border-radius:10px;border-collapse:separate;overflow:hidden">',
    `<tr><td style="background:${brand.colorTopbar};padding:16px 24px">${header}</td></tr>`,
    '<tr><td style="padding:24px">',
    ...paragraphs,
    '</td></tr></table></body></html>',
  ].join('');
}

export interface CodeMailInput {
  lang: Lang;
  to: string;
  brand: Brand;
  /** Base URL of this instance; the logo is served from it. */
  publicUrl?: string;
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
  const brandName = input.brand.name;
  const subject = assertSafeHeader(tr('mail.code.subject', { code: input.code }), 'subject');
  const lines = [
    tr('mail.code.greeting'),
    '',
    tr('mail.code.intro', { case: input.caseName, brand: brandName }),
    '',
    tr('mail.code.code_line', { code: input.code }),
    tr('mail.code.validity', { minutes: input.ttlMinutes }),
    '',
    tr('mail.code.ignore'),
    '',
    '--',
    tr('mail.code.footer', { brand: brandName }),
  ];
  if (input.brand.footerText) lines.push(input.brand.footerText);
  // Only an absolute URL is any use in a mailbox, and only when a logo exists.
  const logoUrl = input.brand.logoPath && input.publicUrl ? `${input.publicUrl.replace(/\/+$/, '')}/brand/logo` : null;
  const html = htmlDocument(input.brand, logoUrl, [
    `<p style="margin:0 0 12px">${esc(tr('mail.code.greeting'))}</p>`,
    `<p style="margin:0 0 16px">${esc(tr('mail.code.intro', { case: input.caseName, brand: brandName }))}</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>`,
    `<td style="border-left:4px solid ${input.brand.colorAccent};background:#f5f7fa;border-radius:0 6px 6px 0;padding:14px 20px">`,
    `<div style="font-size:30px;letter-spacing:8px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Consolas,monospace">${esc(input.code)}</div>`,
    `<div style="margin-top:6px;color:#5b6472;font-size:13px">${esc(tr('mail.code.validity', { minutes: input.ttlMinutes }))}</div>`,
    '</td></tr></table>',
    `<p style="margin:0 0 16px;font-size:13px">${esc(tr('mail.code.ignore'))}</p>`,
    `<p style="margin:0;color:#8a919c;font-size:12px">${esc(tr('mail.code.footer', { brand: brandName }))}</p>`,
    // The instance's own footer line, when it has one, exactly as the pages show it.
    input.brand.footerText ? `<p style="margin:4px 0 0;color:#8a919c;font-size:12px">${esc(input.brand.footerText)}</p>` : '',
  ]);
  return { to: input.to, subject, text: lines.join('\n'), html };
}
