import { formatSize } from '../../config.js';
import { translator, type Lang } from '../../i18n.js';
import type { Case } from '../../services/cases.js';
import type { RecipientItem } from '../../services/items.js';
import type { Link } from '../../services/links.js';
import { html, layout, type SafeHtml } from '../html.js';
import { fmtDate } from './admin.js';

export interface DeliverViewBase {
  lang: Lang;
  /** Path of the current page, for the language switcher. */
  path: string;
  /** Per-browser token, submitted with every form on these pages. */
  flowToken: string;
  /** `/d/<token>`: every form and download link is built from it. */
  base: string;
}

function flash(msg?: string, kind: 'error' | 'ok' = 'error'): SafeHtml {
  return msg ? html`<div class="flash flash-${kind}">${msg}</div>` : html``;
}

/**
 * Step 1. Nothing about the delivery is shown here — not the case name, not the
 * recipient's address — because at this point the visitor has only proved that
 * they hold the link.
 */
export function deliverEmailPage(d: DeliverViewBase & { error?: string; notice?: string }): string {
  const t = translator(d.lang);
  return layout({
    lang: d.lang, title: t('deliver.email.title'), path: d.path,
    body: html`<section class="card narrow">
      <h1>${t('deliver.email.title')}</h1>
      ${flash(d.error)}${flash(d.notice, 'ok')}
      <p>${t('deliver.email.intro')}</p>
      <form method="post" action="${d.base}/email" class="stack">
        <input type="hidden" name="_flow" value="${d.flowToken}">
        <label>${t('deliver.email.label')}
          <input name="email" type="email" required autocomplete="email" autofocus inputmode="email" maxlength="254">
        </label>
        <button class="btn btn-primary" type="submit">${t('deliver.email.submit')}</button>
      </form>
    </section>`,
  });
}

/** Step 2: the code that was mailed. */
export function deliverCodePage(d: DeliverViewBase & { minutes: number; error?: string; notice?: string; attemptsLeft?: number }): string {
  const t = translator(d.lang);
  return layout({
    lang: d.lang, title: t('deliver.code.title'), path: d.path,
    body: html`<section class="card narrow">
      <h1>${t('deliver.code.title')}</h1>
      ${flash(d.error)}${flash(d.notice ?? t('deliver.code.sent', { minutes: d.minutes }), 'ok')}
      <form method="post" action="${d.base}/code" class="stack">
        <input type="hidden" name="_flow" value="${d.flowToken}">
        <label>${t('deliver.code.label')}
          <input name="code" class="code-input" required autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="16" pattern="[0-9 -]*">
        </label>
        ${d.attemptsLeft !== undefined ? html`<p class="muted small">${t('deliver.code.attempts_left', { n: d.attemptsLeft })}</p>` : ''}
        <button class="btn btn-primary" type="submit">${t('deliver.code.submit')}</button>
      </form>
      <form method="post" action="${d.base}/restart" class="inline">
        <input type="hidden" name="_flow" value="${d.flowToken}">
        <button class="btn btn-link" type="submit">${t('deliver.code.again')}</button>
      </form>
    </section>`,
  });
}

export interface PackagePageData extends DeliverViewBase {
  case: Case;
  link: Link;
  items: RecipientItem[];
  /** Openings still available after this one, or null when unlimited. */
  opensLeft: number | null;
  sessionExpiresAt: string;
}

/** Step 3: what the recipient came for. */
export function deliverPackagePage(d: PackagePageData): string {
  const t = translator(d.lang);
  const notes = d.items.filter((i) => i.kind === 'note');
  const files = d.items.filter((i) => i.kind === 'file');
  return layout({
    lang: d.lang, title: t('deliver.package.title'), path: d.path,
    body: html`
      <section class="card">
        <h1>${d.case.name}</h1>
        ${d.case.description ? html`<p>${d.case.description}</p>` : ''}
        <p class="muted small">${t('deliver.package.intro', { label: d.link.label })}</p>
        <ul class="limits small">
          <li>${d.opensLeft === null ? t('deliver.package.opens_unlimited') : t('deliver.package.opens_left', { n: d.opensLeft })}</li>
          <li>${t('deliver.package.session_until', { date: fmtDate(d.sessionExpiresAt, d.lang) })}</li>
          ${d.link.expires_at ? html`<li>${t('deliver.package.valid_until', { date: fmtDate(d.link.expires_at, d.lang) })}</li>` : ''}
        </ul>
      </section>

      ${d.items.length === 0 ? html`<section class="card"><p class="muted">${t('deliver.package.empty')}</p></section>` : ''}

      ${notes.length ? html`<section class="card">
        <h2>${t('deliver.package.notes')}</h2>
        ${notes.map((n) => html`<article class="note">
          <h3>${n.title}</h3>
          <pre class="note-body">${n.body ?? ''}</pre>
        </article>`)}
      </section>` : ''}

      ${files.length ? html`<section class="card">
        <h2>${t('deliver.package.files')}</h2>
        <table>
          <thead><tr><th>${t('items.col.item')}</th><th>${t('items.col.size')}</th><th>${t('items.col.added')}</th><th></th></tr></thead>
          <tbody>${files.map((f) => html`<tr>
            <td class="filename">${f.title}</td>
            <td>${f.size != null ? formatSize(f.size) : '—'}</td>
            <td>${fmtDate(f.ready_at, d.lang)}</td>
            <td class="nowrap"><a class="btn btn-primary" href="${d.base}/files/${f.id}">${t('deliver.package.download')}</a></td>
          </tr>`)}</tbody>
        </table>
      </section>` : ''}

      <section class="card">
        <form method="post" action="${d.base}/close" class="inline">
          <input type="hidden" name="_flow" value="${d.flowToken}">
          <button class="btn" type="submit">${t('deliver.package.close')}</button>
        </form>
      </section>`,
  });
}

export function linkUnavailablePage(lang: Lang, title: string, message: string): string {
  const t = translator(lang);
  return layout({ lang, title, path: '/', body: html`<section class="card narrow"><h1>${title}</h1><p>${message}</p><p class="muted small">${t('link.contact')}</p></section>` });
}
