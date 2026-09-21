import { formatSize } from '../../config.js';
import type { Config } from '../../config.js';
import { clientMessages, translator, type Lang, type Translator } from '../../i18n.js';
import type { AuditRow } from '../../services/audit.js';
import type { Case, CaseSummary } from '../../services/cases.js';
import type { ItemRow } from '../../services/items.js';
import type { Link } from '../../services/links.js';
import { linkState } from '../../services/links.js';
import { html, jsonScript, layout, raw, type SafeHtml } from '../html.js';

export interface AdminViewContext { lang: Lang; csrfToken: string; username: string; path: string }

export function adminNav(v: AdminViewContext): SafeHtml {
  const t = translator(v.lang);
  return html`<nav class="nav">
    <a href="/admin">${t('nav.cases')}</a>
    <a href="/admin/audit">${t('nav.audit')}</a>
    <a href="/admin/security">${t('nav.security')}</a>
    <span class="muted">${v.username}</span>
    <form method="post" action="/admin/logout" class="inline"><input type="hidden" name="_csrf" value="${v.csrfToken}"><button class="btn btn-link" type="submit">${t('nav.logout')}</button></form>
  </nav>`;
}

export function fmtDate(iso: string | null | undefined, lang: Lang = 'en'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}

function flash(msg?: string, kind: 'error' | 'ok' = 'error'): SafeHtml {
  return msg ? html`<div class="flash flash-${kind}">${msg}</div>` : html``;
}

/** Public root: no case/link context here, so there is nothing useful to show or redirect to. */
export function homePage(lang: Lang): string {
  const t = translator(lang);
  return layout({
    lang, title: t('home.title'), path: '/',
    body: html`<section class="card narrow"><h1>${t('home.title')}</h1><p>${t('home.message')}</p></section>`,
  });
}

export function loginPage(lang: Lang, opts: { error?: string }): string {
  const t = translator(lang);
  return layout({
    lang, title: t('login.title'), path: '/admin/login',
    body: html`<section class="card narrow">
      <h1>${t('login.title')}</h1>
      ${flash(opts.error)}
      <form method="post" action="/admin/login">
        <label>${t('login.username')} <input name="username" required autocomplete="username" autofocus></label>
        <label>${t('login.password')} <input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn btn-primary" type="submit">${t('login.submit')}</button>
      </form>
    </section>`,
  });
}

export function casesPage(v: AdminViewContext, cases: CaseSummary[], opts: { error?: string } = {}): string {
  const t = translator(v.lang);
  return layout({
    lang: v.lang, title: t('nav.cases'), nav: adminNav(v), path: v.path,
    body: html`
      <section class="card">
        <h1>${t('cases.new')}</h1>
        ${flash(opts.error)}
        <form method="post" action="/admin/cases" class="row">
          <input type="hidden" name="_csrf" value="${v.csrfToken}">
          <label class="grow">${t('cases.name')} <input name="name" required maxlength="200" placeholder="${t('cases.name_placeholder')}"></label>
          <label class="grow">${t('cases.description_optional')} <input name="description" maxlength="5000"></label>
          <button class="btn btn-primary" type="submit">${t('common.create')}</button>
        </form>
      </section>
      <section class="card">
        <h1>${t('cases.list')}</h1>
        ${cases.length === 0 ? html`<p class="muted">${t('cases.empty')}</p>` : html`
        <table>
          <thead><tr><th>${t('cases.col.name')}</th><th>${t('cases.col.status')}</th><th>${t('cases.col.links')}</th><th>${t('cases.col.items')}</th><th>${t('cases.col.size')}</th><th>${t('cases.col.created')}</th></tr></thead>
          <tbody>
          ${cases.map((c) => html`<tr>
            <td><a href="/admin/cases/${c.id}">${c.name}</a></td>
            <td><span class="badge badge-${c.status}">${t(c.status === 'open' ? 'case.open' : 'case.closed')}</span></td>
            <td>${c.link_count}</td><td>${c.item_count}</td><td>${formatSize(c.total_bytes)}</td><td>${fmtDate(c.created_at, v.lang)}</td>
          </tr>`)}
          </tbody>
        </table>`}
      </section>`,
  });
}

export interface CasePageData {
  case: Case;
  links: Link[];
  items: ItemRow[];
  cfg: Config;
  newLink?: { label: string; url: string };
  error?: string;
  ok?: string;
}

function itemStatus(t: Translator, status: string): string {
  const key = `items.status.${status}` as Parameters<Translator>[0];
  return t(key) === key ? status : t(key);
}

export function casePage(v: AdminViewContext, d: CasePageData): string {
  const t = translator(v.lang);
  const c = d.case;
  const csrf = html`<input type="hidden" name="_csrf" value="${v.csrfToken}">`;
  const uploaderConfig = {
    tusEndpoint: '/admin/api/tus',
    caseId: c.id,
    csrfToken: v.csrfToken,
    chunkSize: d.cfg.uploadChunkBytes,
    maxFileBytes: d.cfg.maxFileBytes,
    lang: v.lang,
    i18n: clientMessages(v.lang),
  };
  return layout({
    lang: v.lang, title: c.name, nav: adminNav(v), path: v.path,
    scripts: ['/static/vendor/tus.min.js', '/static/admin-upload.js', '/static/admin.js'],
    body: html`
      ${jsonScript('outletbox-config', uploaderConfig)}
      <p><a href="/admin">${t('common.back_to_cases')}</a></p>
      <section class="card">
        <div class="row space-between">
          <h1>${c.name} <span class="badge badge-${c.status}">${t(c.status === 'open' ? 'case.open' : 'case.closed')}</span></h1>
          <form method="post" action="/admin/cases/${c.id}/status" class="inline">${csrf}
            <input type="hidden" name="status" value="${c.status === 'open' ? 'closed' : 'open'}">
            <button class="btn" type="submit">${t(c.status === 'open' ? 'case.close' : 'case.reopen')}</button>
          </form>
        </div>
        ${flash(d.error)}${flash(d.ok, 'ok')}
        <form method="post" action="/admin/cases/${c.id}" class="row">${csrf}
          <label class="grow">${t('cases.name')} <input name="name" value="${c.name}" required maxlength="200"></label>
          <label class="grow">${t('cases.description')} <input name="description" value="${c.description}" maxlength="5000"></label>
          <button class="btn" type="submit">${t('common.save')}</button>
        </form>
        <p class="muted small">${t('case.meta', { id: c.id, date: fmtDate(c.created_at, v.lang) })}</p>
      </section>

      ${d.newLink ? html`<section class="card highlight">
        <h2>${t('case.new_link.title', { label: d.newLink.label })}</h2>
        <p><strong>${t('case.new_link.copy_now')}</strong> ${t('case.new_link.intro')}</p>
        <div class="copy-row"><input class="mono" readonly value="${d.newLink.url}" data-copy-source><button class="btn" type="button" data-copy>${t('common.copy')}</button></div>
      </section>` : ''}

      <section class="card">
        <h2>${t('items.title')}</h2>
        <p class="muted small">${t('items.intro')}</p>
        <div id="dropzone" class="dropzone" tabindex="0">
          <p class="dropzone-lead"><strong>${t('items.drop_here')}</strong> ${t('items.or')} <label class="link" for="file-input">${t('items.choose')}</label>.</p>
          <input id="file-input" type="file" multiple hidden>
          <p class="muted small">${t('items.upload_hint', { max: formatSize(d.cfg.maxFileBytes) })}</p>
        </div>
        <ul id="queue" class="queue"></ul>

        <details class="collapsible">
          <summary>${t('items.note.title')}</summary>
          <form method="post" action="/admin/cases/${c.id}/notes" class="stack">${csrf}
            <label>${t('items.note.subject')} <input name="title" required maxlength="200" placeholder="${t('items.note.subject_placeholder')}"></label>
            <label>${t('items.note.body')} <textarea name="body" required rows="5" maxlength="20000" placeholder="${t('items.note.body_placeholder')}"></textarea></label>
            <div><button class="btn btn-primary" type="submit">${t('common.add')}</button></div>
          </form>
        </details>

        ${d.items.length === 0 ? html`<p class="muted">${t('items.empty')}</p>` : html`
        <table>
          <thead><tr><th>${t('items.col.item')}</th><th>${t('items.col.kind')}</th><th>${t('items.col.size')}</th><th>${t('items.col.status')}</th><th>${t('items.col.added')}</th><th>SHA-256</th><th></th></tr></thead>
          <tbody>${d.items.map((i) => html`<tr>
            <td class="filename">${i.title}${i.kind === 'note' && i.body ? html`<br><span class="muted small">${i.body.slice(0, 120)}${i.body.length > 120 ? '…' : ''}</span>` : ''}</td>
            <td>${t(i.kind === 'note' ? 'items.kind.note' : 'items.kind.file')}</td>
            <td>${i.size != null ? formatSize(i.size) : i.declared_size != null ? html`<span class="muted">${t('items.declared', { size: formatSize(i.declared_size) })}</span>` : '—'}</td>
            <td><span class="badge badge-${i.status}">${itemStatus(t, i.status)}</span></td>
            <td>${fmtDate(i.ready_at ?? i.created_at, v.lang)}</td>
            <td class="mono small">${i.sha256 ? i.sha256.slice(0, 12) + '…' : '—'}</td>
            <td class="nowrap">
              ${i.kind === 'file' && i.status === 'ready' ? html`<a class="btn" href="/admin/items/${i.id}/download">${t('items.download')}</a> ` : ''}
              ${['ready', 'missing'].includes(i.status) ? html`<form method="post" action="/admin/items/${i.id}/delete" class="inline" data-confirm="${t('items.delete_confirm', { name: i.title })}">${csrf}<button class="btn btn-danger" type="submit">${t('items.delete')}</button></form>` : ''}
            </td>
          </tr>`)}</tbody>
        </table>`}
        <p class="muted small">${t('items.untrusted')}</p>
      </section>

      <section class="card">
        <h2>${t('links.title')}</h2>
        <p class="muted small">${t('links.intro')}</p>
        <p class="muted small">${t('links.handover')}</p>
        <p class="muted small">${t('links.mail_driver', { driver: d.cfg.mail.driver })}</p>
        <details ${c.status === 'open' ? 'open' : ''}>
          <summary>${t('links.generate')}</summary>
          <form method="post" action="/admin/cases/${c.id}/links" class="grid">${csrf}
            <label>${t('links.label')} <input name="label" required maxlength="200" placeholder="${t('links.label_placeholder')}"></label>
            <label>${t('links.email')} <input name="email" type="email" required maxlength="254" placeholder="jan.kowalski@example.com"></label>
            <label>${t('links.expires')} <input name="expires_at" type="datetime-local"></label>
            <label>${t('links.max_opens')} <input name="max_opens" type="number" min="1" step="1" placeholder="3"></label>
            <div class="grid-full muted small">${t('links.max_opens_hint')}</div>
            <div><button class="btn btn-primary" type="submit" ${c.status !== 'open' ? 'disabled' : ''}>${t('links.submit')}</button></div>
          </form>
        </details>
        ${d.links.length === 0 ? html`<p class="muted">${t('links.empty')}</p>` : html`
        <table>
          <thead><tr><th>${t('links.col.recipient')}</th><th>${t('links.col.state')}</th><th>${t('links.col.expires')}</th><th>${t('links.col.opens')}</th><th>${t('links.col.last_used')}</th><th></th></tr></thead>
          <tbody>${d.links.map((l) => {
            const state = linkState(l, c);
            return html`<tr>
              <td>${l.label}<br><span class="muted small">${l.recipient_email}</span><br><span class="muted small mono">${l.token_hint}…</span></td>
              <td><span class="badge badge-${state}">${t(`links.state.${state}`)}</span></td>
              <td>${l.expires_at ? fmtDate(l.expires_at, v.lang) : t('common.no_expiry')}</td>
              <td>${l.max_opens != null ? t('links.opens', { used: l.opens_used, max: l.max_opens }) : t('links.opens_unlimited', { used: l.opens_used })}</td>
              <td>${fmtDate(l.last_used_at, v.lang)}</td>
              <td class="nowrap">
                ${l.revoked_at ? '' : html`
                  <form method="post" action="/admin/links/${l.id}/reissue" class="inline" data-confirm="${t('links.reissue_confirm', { label: l.label })}">${csrf}<button class="btn" type="submit">${t('links.reissue')}</button></form>
                  <form method="post" action="/admin/links/${l.id}/revoke" class="inline" data-confirm="${t('links.revoke_confirm', { label: l.label })}">${csrf}<button class="btn btn-danger" type="submit">${t('links.revoke')}</button></form>`}
              </td>
            </tr>`;
          })}</tbody>
        </table>`}
      </section>`,
  });
}

export function auditPage(v: AdminViewContext, rows: AuditRow[]): string {
  const t = translator(v.lang);
  return layout({
    lang: v.lang, title: t('nav.audit'), nav: adminNav(v), path: v.path,
    body: html`<section class="card">
      <h1>${t('audit.title', { n: rows.length })}</h1>
      <!-- Opaque ids and a raw JSON details blob are both unbounded, so every wide cell
           has to be breakable and the table scrolls inside its card rather than pushing
           the page sideways. -->
      <div class="table-scroll">
      <table class="small audit">
        <thead><tr><th>${t('audit.col.time')}</th><th>${t('audit.col.actor')}</th><th>${t('audit.col.action')}</th><th>${t('audit.col.case')}</th><th>${t('audit.col.link')}</th><th>${t('audit.col.item')}</th><th>${t('audit.col.ip')}</th><th>${t('audit.col.details')}</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr>
          <td class="nowrap">${fmtDate(r.ts, v.lang)}</td><td class="id">${r.actor_type}:${r.actor_id ?? '-'}</td><td>${r.action}</td>
          <td class="mono id">${r.case_id ? html`<a href="/admin/cases/${r.case_id}">${r.case_id}</a>` : ''}</td>
          <td class="mono id">${r.link_id ?? ''}</td><td class="mono id">${r.item_id ?? ''}</td><td class="nowrap">${r.ip ?? ''}</td>
          <td class="mono details">${r.details ? html`<span>${r.details}</span>` : ''}</td>
        </tr>`)}</tbody>
      </table>
      </div>
    </section>`,
  });
}

export function errorPage(lang: Lang, title: string, message: string, status = 404, path = '/', homeHref = '/'): { status: number; body: string } {
  const t = translator(lang);
  return { status, body: layout({ lang, title, path, body: html`<section class="card narrow"><h1>${title}</h1><p>${message}</p><p><a href="${homeHref}">${t('common.home')}</a></p></section>` }) };
}

export { raw };
