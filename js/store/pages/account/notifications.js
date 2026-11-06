/*
 * Account → notifications: the messages the shop writes to users/{uid}/notifications when an order moves along
 * (confirmed, shipped, delivered, return decisions, …). Live list (newest 50): marking one read or deleting it
 * is reflected immediately. These are in-app messages only — there is no push channel here.
 */
import { html, render, bindActions } from '../../../core/dom.js';
import { registerBoth, t, tn } from '../../../core/i18n.js';
import { icon } from '../../../core/icons.js';
import { skeletonRows, emptyState, errorState, toastError } from '../../../core/ui.js';
import { explainError } from '../../../core/errors.js';
import { relTime, fmtDateTime, num } from '../../../core/format.js';
import { currentUid } from '../../../data/auth.js';
import { watchNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification } from '../../../data/account.js';

registerBoth({
  'nt.title': ['Notifications', 'নোটিফিকেশন'],
  'nt.unread_one': ['{n} unread', '{n}টি না-পড়া'],
  'nt.unread_other': ['{n} unread', '{n}টি না-পড়া'],
  'nt.allRead': ['You are all caught up.', 'সব পড়া হয়ে গেছে।'],
  'nt.markAll': ['Mark all as read', 'সবগুলো পড়া হয়েছে'],
  'nt.empty': ['No notifications yet', 'এখনও কোনো নোটিফিকেশন নেই'],
  'nt.emptyText': ['Updates about your orders will appear here.', 'আপনার অর্ডারের আপডেট এখানে দেখা যাবে।'],
  'nt.unreadLabel': ['Unread', 'না-পড়া'],
  'nt.viewOrder': ['View order', 'অর্ডার দেখুন'],
  'nt.markRead': ['Mark as read', 'পড়া হয়েছে'],
  'nt.delete': ['Delete notification', 'নোটিফিকেশন মুছুন'],
  'nt.loadError': ['Your notifications could not be loaded.', 'নোটিফিকেশন লোড করা যায়নি।'],
});

function itemHtml(n) {
  return html`<li class="ntf ${n.read ? '' : 'is-unread'}">
    <span class="ntf-dot" aria-hidden="true"></span>
    <div class="ntf-body">
      <p class="ntf-title">${n.read ? '' : html`<span class="sr-only">${t('nt.unreadLabel')}: </span>`}${n.title}</p>
      ${n.body ? html`<p class="ntf-text">${n.body}</p>` : ''}
      <p class="ntf-meta muted"><time title="${fmtDateTime(n.createdMs)}">${relTime(n.createdMs)}</time>${n.orderNumber ? html` · <a href="/account/orders/${encodeURIComponent(n.orderNumber)}" data-action="open" data-id="${n.id}">${t('nt.viewOrder')}</a>` : ''}</p>
    </div>
    <div class="ntf-actions">
      ${n.read ? '' : html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="read" data-id="${n.id}" aria-label="${t('nt.markRead')}" title="${t('nt.markRead')}">${icon('check', { size: 18 })}</button>`}
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="del" data-id="${n.id}" aria-label="${t('nt.delete')}" title="${t('nt.delete')}">${icon('trash', { size: 18 })}</button>
    </div>
  </li>`;
}

export default {
  mount(ctx) {
    const uid = currentUid();
    const host = ctx.el;
    let items = null;
    render(host, skeletonRows(4));

    const paint = () => {
      // The list is repainted on every snapshot: keep keyboard focus on the same control when it still exists.
      const active = document.activeElement;
      const key = active && host.contains(active) && active.dataset.action ? `[data-action="${active.dataset.action}"][data-id="${CSS.escape(active.dataset.id || '')}"]` : null;
      const unread = items.filter((n) => !n.read).length;
      render(host, html`
        <section class="acc-card" aria-labelledby="nt-title">
          <div class="acc-card-head">
            <div><h2 id="nt-title" tabindex="-1">${t('nt.title')}</h2>${items.length ? html`<p class="muted" role="status">${unread ? tn('nt.unread', unread, { n: num(unread) }) : t('nt.allRead')}</p>` : ''}</div>
            ${unread ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="readAll">${icon('check', { size: 16 })}<span>${t('nt.markAll')}</span></button>` : ''}
          </div>
          ${items.length ? html`<ul class="ntf-list">${items.map(itemHtml)}</ul>` : emptyState({ icon: 'bell', title: t('nt.empty'), text: t('nt.emptyText') })}
        </section>`);
      if (key) {
        const again = host.querySelector(key);
        if (again) again.focus({ preventScroll: true });
        else host.querySelector('#nt-title')?.focus({ preventScroll: true });
      }
    };

    const off = watchNotifications(uid, (list) => { if (ctx.signal.aborted) return; items = list; paint(); }, (e) => {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(host, errorState({ text: t('nt.loadError') }));
    });
    ctx.cleanup(off);

    const guard = async (fn) => { try { await fn(); } catch (e) { toastError(explainError(e)); } };
    ctx.cleanup(bindActions(host, {
      retry: () => ctx.router.reload(),
      read: (el) => guard(() => markNotificationRead(uid, el.dataset.id)),
      readAll: () => guard(() => markAllNotificationsRead(uid, (items || []).filter((n) => !n.read).map((n) => n.id))),
      del: (el) => guard(() => deleteNotification(uid, el.dataset.id)),
      open: (el, ev) => {
        if (ev.metaKey || ev.ctrlKey) return;
        markNotificationRead(uid, el.dataset.id).catch(() => {}); // best effort: opening the order is what matters
        ctx.router.navigate(el.getAttribute('href'));
      },
    }));
  },
};
