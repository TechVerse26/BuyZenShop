/*
 * Account → overview: greeting, three counters, the latest orders and the profile form.
 * Profile fields live in users/{uid} (data/auth.saveProfile); the email comes from the sign-in method and cannot be edited here.
 */
import { html, render, bindActions, readForm, withBusy } from '../../../core/dom.js';
import { registerBoth, t } from '../../../core/i18n.js';
import { icon } from '../../../core/icons.js';
import { skeletonRows, fieldHtml, toast, toastError, errorState } from '../../../core/ui.js';
import { validateForm, showFormErrors, required, minLen, phone } from '../../../core/validate.js';
import { explainError } from '../../../core/errors.js';
import { initials, num } from '../../../core/format.js';
import { getAuthState, currentUid, saveProfile, logout } from '../../../data/auth.js';
import { listMyOrders } from '../../../data/orders.js';
import { listAddresses } from '../../../data/account.js';
import { wishlist } from '../../../data/wishlist.js';
import { OPEN_STATUSES } from '../../../shared/constants.js';
import { orderRowHtml } from '../../components/orderParts.js';

registerBoth({
  'ao.hello': ['Hello, {name}', 'হ্যালো, {name}'],
  'ao.hello2': ['Welcome back', 'স্বাগতম'],
  'ao.signout': ['Sign out', 'লগআউট'],
  'ao.open': ['Open orders', 'চলমান অর্ডার'],
  'ao.all': ['All orders', 'মোট অর্ডার'],
  'ao.addresses': ['Saved addresses', 'সেভ করা ঠিকানা'],
  'ao.wishlist': ['Wishlist', 'পছন্দের তালিকা'],
  'ao.recent': ['Recent orders', 'সাম্প্রতিক অর্ডার'],
  'ao.viewAll': ['View all', 'সব দেখুন'],
  'ao.noOrders': ['You have not placed an order yet.', 'আপনি এখনও কোনো অর্ডার করেননি।'],
  'ao.shop': ['Start shopping', 'কেনাকাটা শুরু করুন'],
  'ao.profile': ['Profile', 'প্রোফাইল'],
  'ao.name': ['Full name', 'পূর্ণ নাম'],
  'ao.phone': ['Mobile number', 'মোবাইল নম্বর'],
  'ao.phoneHint': ['Used to confirm deliveries.', 'ডেলিভারি নিশ্চিত করতে ব্যবহার হয়।'],
  'ao.email': ['Email', 'ইমেইল'],
  'ao.emailHint': ['Comes from your sign-in method.', 'সাইন-ইন পদ্ধতি থেকে নেওয়া।'],
  'ao.notify': ['Email me updates about my orders', 'অর্ডারের আপডেট ইমেইলে পাঠান'],
  'ao.save': ['Save changes', 'পরিবর্তন সেভ করুন'],
  'ao.saved': ['Profile saved', 'প্রোফাইল সেভ হয়েছে'],
  'ao.loadError': ['Your account data could not be loaded.', 'অ্যাকাউন্টের তথ্য লোড করা যায়নি।'],
});

export default {
  async mount(ctx) {
    const uid = currentUid();
    render(ctx.el, skeletonRows(4));
    let orders; let addresses;
    try {
      [orders, addresses] = await Promise.all([listMyOrders(uid, { limit: 100 }), listAddresses(uid).catch(() => [])]);
    } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(ctx.el, errorState({ text: t('ao.loadError') }));
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;

    const { user, profile } = getAuthState();
    const name = (profile && profile.displayName) || (user && user.displayName) || '';
    const email = (profile && profile.email) || (user && user.email) || '';
    const notify = !profile || !profile.notifyPrefs || profile.notifyPrefs.email !== false;
    const open = orders.filter((o) => OPEN_STATUSES.includes(o.status)).length;

    render(ctx.el, html`
      <section class="acc-card acc-hello">
        <span class="acc-avatar" aria-hidden="true">${initials(name || email)}</span>
        <div class="acc-hello-text"><h2>${name ? t('ao.hello', { name }) : t('ao.hello2')}</h2><p class="muted">${email}</p></div>
        <button type="button" class="btn btn-secondary btn-sm" data-action="logout">${icon('log-out', { size: 16 })}<span>${t('ao.signout')}</span></button>
      </section>

      <div class="acc-tiles">
        <a class="acc-tile" href="/account/orders"><strong>${num(open)}</strong><span>${t('ao.open')}</span></a>
        <a class="acc-tile" href="/account/orders"><strong>${num(orders.length)}</strong><span>${t('ao.all')}</span></a>
        <a class="acc-tile" href="/account/addresses"><strong>${num(addresses.length)}</strong><span>${t('ao.addresses')}</span></a>
        <a class="acc-tile" href="/wishlist"><strong>${num(wishlist.count())}</strong><span>${t('ao.wishlist')}</span></a>
      </div>

      <section class="acc-card" aria-labelledby="ao-recent">
        <div class="acc-card-head"><h2 id="ao-recent">${t('ao.recent')}</h2>${orders.length ? html`<a href="/account/orders">${t('ao.viewAll')}</a>` : ''}</div>
        ${orders.length
    ? html`<ul class="ord-list">${orders.slice(0, 3).map(orderRowHtml)}</ul>`
    : html`<p class="muted">${t('ao.noOrders')}</p><a class="btn btn-primary" href="/shop">${t('ao.shop')}</a>`}
      </section>

      <section class="acc-card" aria-labelledby="ao-profile">
        <h2 id="ao-profile">${t('ao.profile')}</h2>
        <form class="acc-form" data-form="profile" novalidate>
          ${fieldHtml({ name: 'displayName', label: t('ao.name'), value: name, required: true, autocomplete: 'name', attrs: { maxlength: 80 } })}
          ${fieldHtml({ name: 'phone', label: t('ao.phone'), type: 'tel', value: (profile && profile.phone) || '', autocomplete: 'tel', inputmode: 'tel', hint: t('ao.phoneHint') })}
          ${fieldHtml({ name: 'email', label: t('ao.email'), type: 'email', value: email, hint: t('ao.emailHint'), attrs: { readonly: true } })}
          ${fieldHtml({ name: 'notifyEmail', label: t('ao.notify'), type: 'checkbox', value: notify })}
          <div><button type="submit" class="btn btn-primary">${t('ao.save')}</button></div>
        </form>
      </section>`);

    ctx.cleanup(bindActions(ctx.el, {
      logout: async () => { await logout(); ctx.router.navigate('/', { replace: true }); },
    }, {
      submit: {
        profile: async (form) => {
          const v = readForm(form);
          const { ok, errors } = validateForm(v, { displayName: [required, minLen(2)], phone: [phone] });
          showFormErrors(form, errors);
          if (!ok) return;
          await withBusy(form.querySelector('[type="submit"]'), async () => {
            try {
              await saveProfile({ displayName: v.displayName, phone: v.phone, notifyPrefs: { email: v.notifyEmail === true } });
              toast(t('ao.saved'));
              const h = ctx.el.querySelector('.acc-hello-text h2'); if (h) h.textContent = t('ao.hello', { name: v.displayName });
              const av = ctx.el.querySelector('.acc-avatar'); if (av) av.textContent = initials(v.displayName);
            } catch (e) { toastError(explainError(e)); }
          });
        },
      },
    }));
  },
};
