import { formatSize } from '../../config.js';
import type { Config } from '../../config.js';
import { clientMessages, LANG_NAMES, LANGS, translator, type Lang, type Translator } from '../../i18n.js';
import type { AuditRow } from '../../services/audit.js';
import type { Role } from '../../services/auth.js';
import type { CaseMember, UserSummary } from '../../services/users.js';
import type { Case, CaseSummary } from '../../services/cases.js';
import type { ItemRow } from '../../services/items.js';
import { formatRecipients } from '../../services/addresses.js';
import { canEditGroup, type Group } from '../../services/groups.js';
import type { Link, LinkRecipient } from '../../services/links.js';
import { linkState } from '../../services/links.js';
import { fmtDate, html, jsonScript, layout, raw, tHtml, type SafeHtml } from '../html.js';

export interface AdminViewContext { lang: Lang; csrfToken: string; username: string; path: string; role: Role; userId: string }

export function adminNav(v: AdminViewContext): SafeHtml {
  const t = translator(v.lang);
  return html`<nav class="nav">
    <a href="/admin">${t('nav.cases')}</a>
    <a href="/admin/groups">${t('nav.groups')}</a>
    ${v.role === 'admin' ? html`<a href="/admin/users">${t('nav.users')}</a>
    <a href="/admin/audit">${t('nav.audit')}</a>` : ''}
    <a href="/admin/security">${t('nav.security')}</a>
    <span class="muted">${v.username}</span>
    <form method="post" action="/admin/logout" class="inline"><input type="hidden" name="_csrf" value="${v.csrfToken}"><button class="btn btn-link" type="submit">${t('nav.logout')}</button></form>
  </nav>`;
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
        ${cases.length === 0 ? html`<p class="muted">${t(v.role === 'admin' ? 'cases.empty' : 'cases.empty_assigned')}</p>` : html`
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
  /** Recipients per link id. */
  recipients: Map<string, LinkRecipient[]>;
  groups: Group[];
  items: ItemRow[];
  cfg: Config;
  /** People assigned to the case, and (for an administrator) who else could be. */
  members: CaseMember[];
  assignable: CaseMember[];
  newLink?: { label: string; url: string };
  error?: string;
  ok?: string;
}

/** An address that may wrap only before its "@": never in the middle of a name or a domain. */
function breakableEmail(email: string): SafeHtml {
  const at = email.lastIndexOf('@');
  return at > 0 ? html`${email.slice(0, at)}<wbr>${email.slice(at)}` : html`${email}`;
}

/** Language picker for addresses that do not name one; starts on the panel's language. */
function langSelect(t: Translator, current: Lang): SafeHtml {
  return html`<label>${t('links.lang')} <select name="lang">
    ${LANGS.map((l) => html`<option value="${l}" lang="${l}" ${l === current ? raw('selected') : ''}>${LANG_NAMES[l]}</option>`)}
  </select></label>`;
}

/**
 * The address list plus, when groups exist, a picker for one. `admin.js` copies
 * a picked group into the text area and clears the picker, so what is about to
 * be granted is visible before it is submitted; without JavaScript the server
 * merges the group in instead. The text area is only `required` when there is
 * no group to pick instead.
 */
function recipientFields(t: Translator, lang: Lang, groups: Group[]): SafeHtml {
  return html`
    <label class="grid-full">${t('links.recipients')}
      <textarea name="recipients" rows="4" class="mono" ${groups.length === 0 ? raw('required') : ''} placeholder="jan.kowalski@example.com&#10;anna.schmidt@example.com de"></textarea></label>
    <div class="grid-full muted small">${t('links.recipients_hint')}</div>
    ${groups.length ? html`<label>${t('links.group')} <select name="group" data-group-fill>
      <option value="">${t('links.group_none')}</option>
      ${groups.map((g) => html`<option value="${g.id}">${g.name} (${g.members.length})</option>`)}
    </select></label>` : ''}
    ${langSelect(t, lang)}
    ${groups.length ? html`<div class="grid-full muted small">${t('links.group_hint')}</div>` : ''}`;
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
  const groupLines = Object.fromEntries(d.groups.map((g) => [g.id, formatRecipients(g.members)]));
  const open = c.status === 'open';
  return layout({
    lang: v.lang, title: c.name, nav: adminNav(v), path: v.path,
    scripts: ['/static/vendor/tus.min.js', '/static/admin-upload.js', '/static/admin.js'],
    body: html`
      ${jsonScript('outletbox-config', uploaderConfig)}
      ${jsonScript('outletbox-groups', groupLines)}
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
        <p class="muted small">${tHtml(v.lang, 'case.meta', { id: c.id, date: fmtDate(c.created_at, v.lang) })}</p>
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
            <td class="filename">${i.title}${i.kind === 'note' && i.body ? html`<br><span class="muted small mono">${i.body.slice(0, 120)}${i.body.length > 120 ? '…' : ''}</span>` : ''}</td>
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
        <details ${open ? 'open' : ''}>
          <summary>${t('links.generate')}</summary>
          <form method="post" action="/admin/cases/${c.id}/links" class="grid">${csrf}
            <label>${t('links.label')} <input name="label" required maxlength="200" placeholder="${t('links.label_placeholder')}"></label>
            <label>${t('links.expires')} <input name="expires_at" type="datetime-local"></label>
            ${recipientFields(t, v.lang, d.groups)}
            <div class="grid-full muted small">${t('links.lang_hint')}</div>
            <label>${t('links.max_opens')} <input name="max_opens" type="number" min="1" step="1" placeholder="3"></label>
            <div class="grid-full muted small">${t('links.max_opens_hint')}</div>
            <div><button class="btn btn-primary" type="submit" ${!open ? 'disabled' : ''}>${t('links.submit')}</button></div>
          </form>
        </details>
        ${d.links.length === 0 ? html`<p class="muted">${t('links.empty')}</p>` : html`
        <table>
          <thead><tr><th>${t('links.col.link')}</th><th>${t('links.col.recipients')}</th><th>${t('links.col.state')}</th><th>${t('links.col.expires')}</th><th>${t('links.col.opens')}</th><th>${t('links.col.last_used')}</th><th></th></tr></thead>
          <tbody>${d.links.map((l) => {
            const state = linkState(l, c);
            const people = d.recipients.get(l.id) ?? [];
            const editable = !l.revoked_at;
            return html`<tr>
              <td>${l.label}<br><span class="muted small mono">${l.token_hint}…</span></td>
              <td>
                <ul class="recipients">${people.map((r) => html`<li>
                  <span class="mono small">${breakableEmail(r.email)}</span>
                  <span class="badge" lang="${r.lang}">${r.lang.toUpperCase()}</span>
                  <span class="muted small">${t('links.recipient_opens', { n: r.opens })}</span>
                  ${editable && people.length > 1 ? html`<form method="post" action="/admin/links/${l.id}/recipients/${r.id}/remove" class="inline" data-confirm="${t('links.recipient_remove_confirm', { email: r.email, label: l.label })}">${csrf}<button class="btn btn-link small" type="submit">${t('links.recipient_remove')}</button></form>` : ''}
                </li>`)}</ul>
                ${editable ? html`<details class="collapsible">
                  <summary>${t('links.add_recipients')}</summary>
                  <form method="post" action="/admin/links/${l.id}/recipients" class="grid">${csrf}
                    ${recipientFields(t, v.lang, d.groups)}
                    <div><button class="btn" type="submit">${t('common.add')}</button></div>
                  </form>
                </details>` : ''}
              </td>
              <td><span class="badge badge-${state}">${t(`links.state.${state}`)}</span></td>
              <td>${l.expires_at ? fmtDate(l.expires_at, v.lang) : t('common.no_expiry')}</td>
              <td>${l.max_opens != null ? t('links.opens', { used: l.opens_used, max: l.max_opens }) : t('links.opens_unlimited', { used: l.opens_used })}</td>
              <td>${fmtDate(l.last_used_at, v.lang)}</td>
              <td class="actions">
                ${l.revoked_at ? '' : html`
                  <form method="post" action="/admin/links/${l.id}/reissue" class="inline" data-confirm="${t('links.reissue_confirm', { label: l.label })}">${csrf}<button class="btn" type="submit">${t('links.reissue')}</button></form>
                  <form method="post" action="/admin/links/${l.id}/revoke" class="inline" data-confirm="${t('links.revoke_confirm', { label: l.label })}">${csrf}<button class="btn btn-danger" type="submit">${t('links.revoke')}</button></form>`}
              </td>
            </tr>`;
          })}</tbody>
        </table>`}
      </section>

      ${membersSection(v, d)}`,
  });
}

export interface GroupsPageData {
  error?: string;
  ok?: string;
  /** The form that failed, refilled: `id` null for the "new group" form. */
  draft?: { id: string | null; name: string; members: string };
}

export function groupsPage(v: AdminViewContext, groups: Group[], d: GroupsPageData = {}): string {
  const t = translator(v.lang);
  const csrf = html`<input type="hidden" name="_csrf" value="${v.csrfToken}">`;
  const newDraft = d.draft && d.draft.id === null ? d.draft : null;
  return layout({
    lang: v.lang, title: t('groups.title'), nav: adminNav(v), path: v.path,
    scripts: ['/static/admin.js'],
    body: html`
      <section class="card">
        <h1>${t('groups.title')}</h1>
        ${flash(d.error)}${flash(d.ok, 'ok')}
        <p class="muted small">${t('groups.intro')}</p>
        <details class="collapsible" ${groups.length === 0 || newDraft ? raw('open') : ''}>
          <summary>${t('groups.new')}</summary>
          <form method="post" action="/admin/groups" class="grid">${csrf}
            <label class="grid-full">${t('groups.name')} <input name="name" required maxlength="200" value="${newDraft?.name ?? ''}" placeholder="${t('groups.name_placeholder')}"></label>
            <label class="grid-full">${t('groups.members')}
              <textarea name="recipients" rows="6" class="mono" required placeholder="jan.kowalski@example.com&#10;anna.schmidt@example.com de">${newDraft?.members ?? ''}</textarea></label>
            <div class="grid-full muted small">${t('links.recipients_hint')}</div>
            ${langSelect(t, v.lang)}
            <div><button class="btn btn-primary" type="submit">${t('common.create')}</button></div>
          </form>
        </details>
      </section>
      <section class="card">
        <h2>${t('groups.list')}</h2>
        ${groups.length === 0 ? html`<p class="muted">${t('groups.empty')}</p>` : groups.map((g) => {
          const draft = d.draft && d.draft.id === g.id ? d.draft : null;
          const owner = g.created_by_name ? t('groups.owner', { username: g.created_by_name }) : t('groups.owner_admins');
          const summary = html`<summary><strong>${g.name}</strong> <span class="muted small">${t('groups.count', { n: g.members.length })} · ${owner}</span></summary>`;
          if (!canEditGroup({ id: v.userId, role: v.role }, g)) {
            return html`<details class="collapsible group">${summary}
              <pre class="mono small">${formatRecipients(g.members)}</pre>
              <p class="muted small">${t('groups.not_yours')}</p>
            </details>`;
          }
          return html`<details class="collapsible group" ${draft ? raw('open') : ''}>
            ${summary}
            <form method="post" action="/admin/groups/${g.id}" class="grid">${csrf}
              <label class="grid-full">${t('groups.name')} <input name="name" required maxlength="200" value="${draft?.name ?? g.name}"></label>
              <label class="grid-full">${t('groups.members')}
                <textarea name="recipients" rows="${Math.min(Math.max(g.members.length + 1, 3), 12)}" class="mono" required>${draft?.members ?? formatRecipients(g.members)}</textarea></label>
              ${langSelect(t, v.lang)}
              <div class="grid-full muted small">${t('groups.edit_hint')}</div>
              <div><button class="btn btn-primary" type="submit">${t('common.save')}</button></div>
            </form>
            <form method="post" action="/admin/groups/${g.id}/delete" class="inline" data-confirm="${t('groups.delete_confirm', { name: g.name })}">${csrf}<button class="btn btn-danger" type="submit">${t('groups.delete')}</button></form>
          </details>`;
        })}
      </section>`,
  });
}

/**
 * Who works on the case. Everyone who can open the case sees the list and can
 * assign or unassign other users (not themselves). Administrators are never
 * listed — they see every case anyway.
 */
function membersSection(v: AdminViewContext, d: CasePageData): SafeHtml {
  const t = translator(v.lang);
  const csrf = html`<input type="hidden" name="_csrf" value="${v.csrfToken}">`;
  const admin = v.role === 'admin';
  return html`<section class="card">
    <h2>${t('members.title')}</h2>
    <p class="muted small">${t('members.intro')}</p>
    ${d.members.length === 0 ? html`<p class="muted">${t('members.empty')}</p>` : html`<ul class="members">${d.members.map((m) => html`<li>
      <span>${m.username}</span>
      ${m.disabled_at ? html`<span class="badge badge-disabled">${t('users.status.disabled')}</span>` : ''}
      ${m.id !== v.userId ? html`<form method="post" action="/admin/cases/${d.case.id}/members/${m.id}/remove" class="inline" data-confirm="${t('members.remove_confirm', { username: m.username })}">${csrf}<button class="btn" type="submit">${t('members.remove')}</button></form>` : ''}
    </li>`)}</ul>`}
    ${d.assignable.length ? html`<form method="post" action="/admin/cases/${d.case.id}/members" class="row">${csrf}
      <label class="grow">${t('members.user')} <select name="user_id" required>
        ${d.assignable.map((u) => html`<option value="${u.id}">${u.username}</option>`)}
      </select></label>
      <button class="btn btn-primary" type="submit">${t('members.add')}</button>
    </form>` : admin
      ? html`<p class="muted small">${raw(t('members.none_assignable', { link: '<a href="/admin/users">' + t('nav.users') + '</a>' }))}</p>`
      : html`<p class="muted small">${t('members.none_assignable_user')}</p>`}
  </section>`;
}

export interface UsersPageData {
  users: UserSummary[];
  /** A password just issued, shown this once. */
  issued?: { username: string; password: string; reset: boolean };
  error?: string;
  ok?: string;
}

function userStatus(t: Translator, u: UserSummary): SafeHtml {
  if (u.disabled_at) return html`<span class="badge badge-disabled">${t('users.status.disabled')}</span>`;
  if (u.must_change_password) return html`<span class="badge badge-pending">${t('users.status.must_change')}</span>`;
  return html`<span class="badge badge-active">${t('users.status.active')}</span>`;
}

export function usersPage(v: AdminViewContext, d: UsersPageData): string {
  const t = translator(v.lang);
  const csrf = html`<input type="hidden" name="_csrf" value="${v.csrfToken}">`;
  const action = (u: UserSummary, path: string, label: string, opts: { danger?: boolean; confirm?: string; field?: [string, string] } = {}) => html`<form method="post" action="/admin/users/${u.id}/${path}" class="inline"${opts.confirm ? html` data-confirm="${opts.confirm}"` : ''}>${csrf}${opts.field ? html`<input type="hidden" name="${opts.field[0]}" value="${opts.field[1]}">` : ''}<button class="btn${opts.danger ? ' btn-danger' : ''}" type="submit">${label}</button></form>`;
  return layout({
    lang: v.lang, title: t('nav.users'), nav: adminNav(v), path: v.path,
    scripts: ['/static/admin.js'],
    body: html`
      <section class="card">
        <h1>${t('users.new')}</h1>
        ${flash(d.error)}${flash(d.ok, 'ok')}
        <form method="post" action="/admin/users" class="row">${csrf}
          <label class="grow">${t('users.username')} <input name="username" required maxlength="64" autocomplete="off" spellcheck="false" placeholder="${t('users.username_placeholder')}"></label>
          <label>${t('users.role')} <select name="role">
            <option value="user" selected>${t('users.role.user')}</option>
            <option value="admin">${t('users.role.admin')}</option>
          </select></label>
          <button class="btn btn-primary" type="submit">${t('common.create')}</button>
        </form>
        <p class="muted small">${t('users.roles_hint')}</p>
      </section>

      ${d.issued ? html`<section class="card highlight">
        <h2>${t(d.issued.reset ? 'users.issued.reset_title' : 'users.issued.title', { username: d.issued.username })}</h2>
        <p><strong>${t('users.issued.copy_now')}</strong> ${t('users.issued.intro')}</p>
        <div class="copy-row"><input class="mono" readonly value="${d.issued.password}" data-copy-source><button class="btn" type="button" data-copy>${t('common.copy')}</button></div>
      </section>` : ''}

      <section class="card">
        <h1>${t('users.list')}</h1>
        <div class="table-scroll">
        <table>
          <thead><tr><th>${t('users.col.username')}</th><th>${t('users.role')}</th><th>${t('users.col.status')}</th><th>${t('users.col.totp')}</th><th>${t('users.col.cases')}</th><th>${t('users.col.last_login')}</th><th></th></tr></thead>
          <tbody>${d.users.map((u) => {
            const self = u.id === v.userId;
            return html`<tr>
              <td>${u.username}${self ? html` <span class="muted small">(${t('users.you')})</span>` : ''}</td>
              <td><span class="badge badge-role-${u.role}">${t(u.role === 'admin' ? 'users.role.admin' : 'users.role.user')}</span></td>
              <td>${userStatus(t, u)}</td>
              <td>${t(u.totp_enabled ? 'security.enabled' : 'security.disabled')}</td>
              <td>${u.role === 'admin' ? html`<span class="muted">${t('users.all_cases')}</span>` : u.case_count}</td>
              <td>${fmtDate(u.last_login_at, v.lang)}</td>
              <td><div class="actions">${self ? html`<a href="/admin/security">${t('nav.security')}</a>` : html`
                ${action(u, 'role', t(u.role === 'admin' ? 'users.make_user' : 'users.make_admin'), { field: ['role', u.role === 'admin' ? 'user' : 'admin'], confirm: t('users.role_confirm', { username: u.username }) })}
                ${action(u, 'password', t('users.reset_password'), { confirm: t('users.reset_password_confirm', { username: u.username }) })}
                ${u.totp_enabled ? action(u, 'totp', t('users.reset_totp'), { confirm: t('users.reset_totp_confirm', { username: u.username }) }) : ''}
                ${u.disabled_at ? action(u, 'enable', t('users.enable')) : action(u, 'disable', t('users.disable'), { confirm: t('users.disable_confirm', { username: u.username }) })}
                ${action(u, 'delete', t('users.delete'), { danger: true, confirm: t('users.delete_confirm', { username: u.username }) })}`}
              </div></td>
            </tr>`;
          })}</tbody>
        </table>
        </div>
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
          <td class="nowrap">${fmtDate(r.ts, v.lang)}</td><td class="id">${r.actor_name ? html`${r.actor_name}<br><span class="muted">${r.actor_id}</span>` : html`${r.actor_type}:${r.actor_id ?? '-'}`}</td><td>${r.action}</td>
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
