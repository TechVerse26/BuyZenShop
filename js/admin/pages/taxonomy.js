/*
 * Categories & brands — one page file, two URLs (route meta.kind: 'categories' | 'brands').
 * Permission: products.read to look, categories.write / brands.write to change (Super Admin, Store Admin, Product Manager).
 *
 *   Categories  a two-level tree (top level, then sub-categories); ▲▼ buttons move a category among its siblings
 *   Brands      a flat list, A–Z
 *   Both        search, product counts, new / edit dialog (name, link, parent, description, image, visible), hide / show, delete
 *               (a category with sub-categories, or one that products or a coupon still use, cannot be deleted — the page does not offer it
 *               and the data layer checks again at delete time)
 * Rules of the game: shared/taxonomyFlow.js. Renaming copies the new name into the products of that category / brand.
 */
import { html, render, bindActions, readForm, raw, debounce, safeUrl } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, toast, toastError, formDialog, confirmDialog, fieldHtml, openMenu, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num } from '../../core/format.js';
import { can } from '../../data/auth.js';
import { KINDS, taxonomyCounts, siblingsOf } from '../../shared/taxonomyFlow.js';
import { safeMount, pageHead, needs, searchField } from '../lib/ui.js';
import { pickFiles } from '../lib/images.js';
import { loadTaxonomy, reloadItems, saveTaxonomy, setTaxonomyVisible, removeTaxonomy, moveCategory, uploadTaxonomyImage, discardUpload } from '../data/taxonomy.js';

registerBoth({
  'tax.cat.title': ['Categories', 'ক্যাটাগরি'],
  'tax.cat.sub': ['Group your products. Customers browse the shop by these. A category can have sub-categories (two levels).', 'পণ্যকে ভাগ করুন। ক্রেতারা এগুলো দিয়ে দোকান ঘুরে দেখেন। একটি ক্যাটাগরির সাব-ক্যাটাগরি থাকতে পারে (দুই স্তর)।'],
  'tax.brand.title': ['Brands', 'ব্র্যান্ড'],
  'tax.brand.sub': ['The makers of your products. Customers can filter the shop by brand.', 'আপনার পণ্যের নির্মাতা। ক্রেতারা ব্র্যান্ড দিয়ে দোকান ফিল্টার করতে পারেন।'],
  'tax.add.category': ['New category', 'নতুন ক্যাটাগরি'],
  'tax.add.brand': ['New brand', 'নতুন ব্র্যান্ড'],
  'tax.search': ['Search by name or link', 'নাম বা লিংক দিয়ে খুঁজুন'],
  'tax.col.name': ['Name', 'নাম'],
  'tax.col.products': ['Products', 'পণ্য'],
  'tax.col.status': ['Status', 'অবস্থা'],
  'tax.col.order': ['Order', 'ক্রম'],
  'tax.status.visible': ['Visible', 'দৃশ্যমান'],
  'tax.status.hidden': ['Hidden', 'লুকানো'],
  'tax.status.parentHidden': ['Hidden with its parent', 'প্যারেন্টসহ লুকানো'],
  'tax.subs_one': ['{n} sub-category', '{n}টি সাব-ক্যাটাগরি'],
  'tax.subs_other': ['{n} sub-categories', '{n}টি সাব-ক্যাটাগরি'],
  'tax.in': ['in {parent}', '{parent}-এর অধীনে'],
  'tax.move.up': ['Move {name} up', '{name} ওপরে তুলুন'],
  'tax.move.down': ['Move {name} down', '{name} নিচে নামান'],
  'tax.menu.more': ['Actions for {name}', '{name}-এর অ্যাকশন'],
  'tax.menu.edit': ['Edit', 'সম্পাদনা'],
  'tax.menu.addSub': ['Add sub-category', 'সাব-ক্যাটাগরি যোগ করুন'],
  'tax.menu.hide': ['Hide from the shop', 'দোকান থেকে লুকান'],
  'tax.menu.show': ['Show in the shop', 'দোকানে দেখান'],
  'tax.menu.delete': ['Delete', 'মুছুন'],
  'tax.empty.category': ['No categories yet', 'এখনও কোনো ক্যাটাগরি নেই'],
  'tax.empty.brand': ['No brands yet', 'এখনও কোনো ব্র্যান্ড নেই'],
  'tax.emptyText.category': ['Create a category, then give your products one.', 'একটি ক্যাটাগরি বানিয়ে পণ্যগুলোকে তাতে রাখুন।'],
  'tax.emptyText.brand': ['Create a brand, then give your products one.', 'একটি ব্র্যান্ড বানিয়ে পণ্যগুলোকে তাতে রাখুন।'],
  'tax.noMatch': ['Nothing matches', 'কিছুই মেলেনি'],
  'tax.noMatchText': ['Change the search.', 'সার্চ বদলান।'],
  'tax.readOnly': ['You can look at this list. Changing it needs the Product Manager, Store Admin or Super Admin role.', 'আপনি এই তালিকা দেখতে পারবেন। বদলাতে প্রোডাক্ট ম্যানেজার, স্টোর অ্যাডমিন বা সুপার অ্যাডমিন ভূমিকা লাগবে।'],
  'tax.footer': ['{n} in total', 'মোট {n}টি'],
  'tax.new.category': ['New category', 'নতুন ক্যাটাগরি'],
  'tax.new.sub': ['New sub-category in {parent}', '{parent}-এর নতুন সাব-ক্যাটাগরি'],
  'tax.new.brand': ['New brand', 'নতুন ব্র্যান্ড'],
  'tax.edit': ['Edit {name}', '{name} সম্পাদনা'],
  'tax.create': ['Create', 'তৈরি করুন'],
  'tax.f.name': ['Name', 'নাম'],
  'tax.f.nameRename': ['The new name is copied to {n} products when you save.', 'সংরক্ষণ করলে নতুন নাম {n}টি পণ্যে কপি হবে।'],
  'tax.f.slug': ['Link', 'লিংক'],
  'tax.f.slugHint': ['Part of the page link: small letters, digits and hyphens. Empty = made from the name. Changing it breaks old links.', 'পেজের লিংকের অংশ: ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন। ফাঁকা = নাম থেকে তৈরি হবে। বদলালে পুরনো লিংক কাজ করবে না।'],
  'tax.f.parent': ['Parent category', 'প্যারেন্ট ক্যাটাগরি'],
  'tax.f.parentNone': ['None (top level)', 'নেই (টপ লেভেল)'],
  'tax.f.parentHint': ['Choose one to make this a sub-category.', 'সাব-ক্যাটাগরি বানাতে একটি বাছুন।'],
  'tax.f.parentLocked': ['It has sub-categories, so it stays on the top level.', 'এর সাব-ক্যাটাগরি আছে, তাই এটি টপ লেভেলেই থাকবে।'],
  'tax.f.description': ['Description (optional)', 'বিবরণ (ঐচ্ছিক)'],
  'tax.f.image': ['Image', 'ছবি'],
  'tax.f.logo': ['Logo', 'লোগো'],
  'tax.f.imageHint': ['JPG, PNG or WebP. It is resized for you.', 'JPG, PNG বা WebP। আকার নিজে থেকেই ছোট হবে।'],
  'tax.f.upload': ['Upload', 'আপলোড'],
  'tax.f.replace': ['Replace', 'বদলান'],
  'tax.f.remove': ['Remove', 'সরান'],
  'tax.f.visible': ['Shown in the shop', 'দোকানে দেখানো হবে'],
  'tax.f.visibleCategory': ['A hidden category and its sub-categories are not shown in the shop. Its products stay on sale.', 'লুকানো ক্যাটাগরি ও তার সাব-ক্যাটাগরি দোকানে দেখা যায় না। এর পণ্য বিক্রিতেই থাকে।'],
  'tax.f.visibleBrand': ['A hidden brand is not offered as a filter. Its products stay on sale.', 'লুকানো ব্র্যান্ড ফিল্টারে দেখা যায় না। এর পণ্য বিক্রিতেই থাকে।'],
  'tax.toast.created': ['Created', 'তৈরি হয়েছে'],
  'tax.toast.renamed': ['Saved. The new name was copied to {n} products.', 'সংরক্ষিত। নতুন নাম {n}টি পণ্যে কপি হয়েছে।'],
  'tax.toast.shown': ['Now shown in the shop', 'এখন দোকানে দেখা যাবে'],
  'tax.toast.hidden': ['Now hidden from the shop', 'এখন দোকান থেকে লুকানো'],
  'tax.toast.deleted': ['Deleted', 'মুছে ফেলা হয়েছে'],
  'tax.del.title': ['Delete {name}?', '{name} মুছবেন?'],
  'tax.del.category': ['No product and no sub-category uses it. It is deleted for good.', 'কোনো পণ্য বা সাব-ক্যাটাগরি এটি ব্যবহার করছে না। এটি স্থায়ীভাবে মুছে যাবে।'],
  'tax.del.brand': ['No product uses this brand. It is deleted for good.', 'কোনো পণ্য এই ব্র্যান্ড ব্যবহার করছে না। এটি স্থায়ীভাবে মুছে যাবে।'],
});

export default {
  async mount(ctx) {
    const kind = ctx.route && ctx.route.meta && ctx.route.meta.kind === 'brands' ? 'brand' : 'category';
    const cfg = KINDS[kind];
    if (!needs(ctx, 'products.read')) return;
    await loadCss('/css/pages/admin-taxonomy.css');
    await safeMount(ctx, async () => {
      const canWrite = can(cfg.write);
      let { items, products } = await loadTaxonomy(kind);
      if (ctx.signal.aborted) return;
      const state = { q: '' };
      const isShown = (c) => c.visible !== false;
      const glyph = kind === 'category' ? 'layers' : 'tag';

      /** rows in display order: a tree for categories (children right under their parent), A–Z for brands */
      const rowsFor = () => {
        if (kind === 'brand') { const all = siblingsOf('brand', items); return all.map((item) => ({ item, depth: 0, sibs: all })); }
        const out = [];
        const tops = siblingsOf('category', items, null);
        for (const top of tops) {
          out.push({ item: top, depth: 0, sibs: tops, parent: null });
          const kids = siblingsOf('category', items, top.id);
          for (const kid of kids) out.push({ item: kid, depth: 1, sibs: kids, parent: top });
        }
        const seen = new Set(out.map((r) => r.item.id));
        for (const c of items) if (!seen.has(c.id)) out.push({ item: c, depth: 0, sibs: [c], parent: null });   // a parent that no longer exists: shown on the top level, can be edited
        return out;
      };

      const results = () => {
        const counts = taxonomyCounts(kind, items, products);
        const needle = state.q.trim().toLowerCase();
        const all = rowsFor();
        if (!all.length) return emptyState({ icon: glyph, title: t(`tax.empty.${kind}`), text: canWrite ? t(`tax.emptyText.${kind}`) : '' });
        const rows = needle ? all.filter((r) => String(r.item.name).toLowerCase().includes(needle) || String(r.item.slug).toLowerCase().includes(needle)) : all;
        if (!rows.length) return emptyState({ icon: 'search', title: t('tax.noMatch'), text: t('tax.noMatchText') });
        const canMove = kind === 'category' && canWrite && !needle;
        const row = ({ item: c, depth, sibs, parent }) => {
          const n = counts.get(c.id) || { products: 0, children: 0 };
          const img = c[cfg.imageField];
          const at = sibs.indexOf(c);
          const status = !isShown(c) ? badge(t('tax.status.hidden'), 'neutral') : parent && !isShown(parent) ? badge(t('tax.status.parentHidden'), 'neutral') : badge(t('tax.status.visible'), 'ok');
          return html`<tr class="${depth ? 'tax-child' : ''}">
            <td class="cell-first"><div class="cell-main"><span class="tax-thumb">${img ? html`<img src="${safeUrl(img)}" alt="" loading="lazy" width="40" height="40">` : icon(glyph, { size: 18 })}</span>
              <div class="tax-name"><span class="t">${c.name}</span><div class="s tax-slug">/${kind}/${c.slug}</div>${needle && parent ? html`<div class="s">${t('tax.in', { parent: parent.name })}</div>` : ''}</div></div></td>
            <td data-label="${t('tax.col.products')}"><div class="tax-cell">${num(n.products)}${n.children ? html`<div class="tax-sub">${tn('tax.subs', n.children, { n: num(n.children) })}</div>` : ''}</div></td>
            <td data-label="${t('tax.col.status')}">${status}</td>
            ${canMove ? html`<td data-label="${t('tax.col.order')}"><div class="tax-move">
              <button type="button" class="btn btn-ghost btn-icon" data-action="move" data-dir="up" data-id="${c.id}" aria-label="${t('tax.move.up', { name: c.name })}" ${at === 0 ? raw('disabled') : ''}>${icon('chevron-up', { size: 18 })}</button>
              <button type="button" class="btn btn-ghost btn-icon" data-action="move" data-dir="down" data-id="${c.id}" aria-label="${t('tax.move.down', { name: c.name })}" ${at === sibs.length - 1 ? raw('disabled') : ''}>${icon('chevron-down', { size: 18 })}</button></div></td>` : ''}
            ${canWrite ? html`<td class="col-actions"><button type="button" class="btn btn-ghost btn-icon" data-action="row-menu" data-id="${c.id}" aria-haspopup="menu" aria-label="${t('tax.menu.more', { name: c.name })}">${icon('more-horizontal', { size: 18 })}</button></td>` : ''}
          </tr>`;
        };
        return html`<div class="table-wrap"><table class="table table-stack table-cards tax-table" id="tax-table">
          <thead><tr><th scope="col">${t('tax.col.name')}</th><th scope="col">${t('tax.col.products')}</th><th scope="col">${t('tax.col.status')}</th>${canMove ? html`<th scope="col">${t('tax.col.order')}</th>` : ''}${canWrite ? html`<th scope="col" class="col-actions"><span class="sr-only">${t('common.actions')}</span></th>` : ''}</tr></thead>
          <tbody>${rows.map(row)}</tbody></table>
          <div class="table-footer"><span>${t('tax.footer', { n: num(rows.length) })}</span></div></div>`;
      };
      const paintResults = () => render(ctx.el.querySelector('#tax-results'), results());
      const paint = () => render(ctx.el, html`
        ${pageHead({ title: t(`tax.${kind === 'category' ? 'cat' : 'brand'}.title`), sub: t(`tax.${kind === 'category' ? 'cat' : 'brand'}.sub`), actions: canWrite ? html`<button type="button" class="btn btn-primary" data-action="add">${icon('plus', { size: 18 })}<span>${t(`tax.add.${kind}`)}</span></button>` : '' })}
        ${canWrite ? '' : html`<div class="alert alert-info" role="note">${icon('info', { size: 18 })}<div>${t('tax.readOnly')}</div></div>`}
        ${items.length ? html`<div class="toolbar" role="search">${searchField({ id: 'q', value: state.q, placeholder: t('tax.search'), label: t('tax.search'), bind: 'q' })}</div>` : ''}
        <div id="tax-results">${results()}</div>`);
      const refresh = async () => { items = await reloadItems(kind); paint(); };
      paint();

      /* ── new / edit ── */
      const openItem = ({ item = null, parentId = '' } = {}) => {
        const creating = !item;
        const counts = taxonomyCounts(kind, items, products);
        const mine = creating ? { products: 0, children: 0 } : counts.get(item.id) || { products: 0, children: 0 };
        const parent = parentId ? items.find((c) => c.id === parentId) : null;
        const tops = siblingsOf('category', items, null).filter((c) => !item || c.id !== item.id);
        const oldPath = creating ? '' : item[cfg.pathField] || '';
        const uploaded = [];                                   // storage files created while this dialog was open
        let saved = null;                                      // { imagePath } of what was stored
        const img0 = creating ? '' : item[cfg.imageField] || '';

        formDialog({
          title: creating ? (parent ? t('tax.new.sub', { parent: parent.name }) : t(`tax.new.${kind}`)) : t('tax.edit', { name: item.name }),
          confirmText: creating ? t('tax.create') : t('common.save'), size: 'lg',
          body: html`<form novalidate data-form="taxonomy"><div class="stack">
            ${fieldHtml({ name: 'name', label: t('tax.f.name'), required: true, value: creating ? '' : item.name, hint: !creating && mine.products ? t('tax.f.nameRename', { n: num(mine.products) }) : '', attrs: { maxlength: 80, autocomplete: 'off' } })}
            ${fieldHtml({ name: 'slug', label: t('tax.f.slug'), value: creating ? '' : item.slug, hint: t('tax.f.slugHint'), attrs: { maxlength: 80, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' } })}
            ${kind === 'category' ? fieldHtml({
    name: 'parentId', label: t('tax.f.parent'), type: 'select', value: parent ? parent.id : creating ? '' : item.parentId || '',
    options: [{ value: '', label: t('tax.f.parentNone') }, ...tops.map((c) => ({ value: c.id, label: c.name }))],
    hint: mine.children ? t('tax.f.parentLocked') : t('tax.f.parentHint'), attrs: mine.children ? { disabled: true } : {},
  }) : ''}
            ${fieldHtml({ name: 'description', label: t('tax.f.description'), type: 'textarea', rows: 3, value: creating ? '' : item.description || '', attrs: { maxlength: 300 } })}
            <div class="field tax-img">
              <label id="tax-img-label">${t(kind === 'category' ? 'tax.f.image' : 'tax.f.logo')}</label>
              <div class="tax-img-row" role="group" aria-labelledby="tax-img-label">
                <span class="tax-img-box" data-img-box></span>
                <div class="tax-img-btns"><button type="button" class="btn btn-sm" data-img="pick"><span data-img-pick-label></span></button><button type="button" class="btn btn-sm btn-ghost" data-img="clear">${t('tax.f.remove')}</button></div>
              </div>
              <input type="hidden" name="image" value="${img0}"><input type="hidden" name="imagePath" value="${oldPath}">
              <div class="field-hint">${t('tax.f.imageHint')}</div><div class="field-error" id="err-image" aria-live="polite"></div>
            </div>
            ${fieldHtml({ name: 'visible', label: t('tax.f.visible'), type: 'switch', value: creating ? true : item.visible !== false, hint: t(kind === 'category' ? 'tax.f.visibleCategory' : 'tax.f.visibleBrand') })}
          </div></form>`,
          onSubmit: async (form) => {
            showFormErrors(form, {});
            const v = readForm(form);
            try {
              const plan = await saveTaxonomy({
                kind, creating, id: creating ? null : item.id,
                form: { name: v.name, slug: v.slug, parentId: v.parentId, description: v.description, image: v.image, imagePath: v.imagePath, visible: v.visible === true },
              });
              saved = { imagePath: v.imagePath || '' };
              toast(creating ? t('tax.toast.created') : plan.renamed ? t('tax.toast.renamed', { n: num(plan.renamed) }) : t('common.saved'));
            } catch (e) {
              if (e && e.code === 'no_change') { toast(t('tax.err.no_change')); return true; }
              if (e && e.code === 'partial') { saved = { imagePath: v.imagePath || '' }; toastError(e.message); await refresh(); return true; }
              if (e && e.errors) { showFormErrors(form, e.errors); return false; }
              if (!isRefusal(e)) reportError(e, 'taxonomy.save');
              toastError(explainError(e));
              return false;
            }
            await refresh();
            return true;
          },
        }).then((ok) => {
          // files that are not the stored image any more (a replaced one, a removed one, everything uploaded in a cancelled dialog) are deleted
          const keep = ok && saved ? saved.imagePath : oldPath;
          for (const path of uploaded) if (path !== keep) discardUpload(path);
          if (ok && saved && oldPath && oldPath !== saved.imagePath) discardUpload(oldPath);
        });

        const form = document.querySelector('[role="dialog"] form[data-form="taxonomy"]');
        if (!form) return;
        const box = form.querySelector('[data-img-box]');
        const inImg = form.querySelector('input[name="image"]');
        const inPath = form.querySelector('input[name="imagePath"]');
        const pick = form.querySelector('[data-img="pick"]');
        const clear = form.querySelector('[data-img="clear"]');
        const paintImage = () => {
          render(box, inImg.value ? html`<img src="${safeUrl(inImg.value)}" alt="">` : icon(glyph, { size: 24 }));
          pick.querySelector('[data-img-pick-label]').textContent = t(inImg.value ? 'tax.f.replace' : 'tax.f.upload');
          clear.hidden = !inImg.value;
        };
        pick.addEventListener('click', async () => {
          const [file] = await pickFiles();
          if (!file) return;
          pick.disabled = true;
          try {
            const r = await uploadTaxonomyImage(kind, file);
            uploaded.push(r.path);
            inImg.value = r.url;
            inPath.value = r.path;
            form.querySelector('#err-image').textContent = '';
            paintImage();
          } catch (e) { reportError(e, 'taxonomy.upload'); toastError(explainError(e)); } finally { pick.disabled = false; }
        });
        clear.addEventListener('click', () => { inImg.value = ''; inPath.value = ''; paintImage(); });
        paintImage();
      };

      /* ── hide / show, delete, move ── */
      const setShown = async (c, visible) => {
        try {
          await setTaxonomyVisible({ kind, id: c.id, visible });
          toast(visible ? t('tax.toast.shown') : t('tax.toast.hidden'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'taxonomy.visible'); toastError(explainError(e)); }
      };
      const remove = async (c) => {
        if (!(await confirmDialog({ title: t('tax.del.title', { name: c.name }), message: t(`tax.del.${kind}`), confirmText: t('tax.menu.delete'), danger: true }))) return;
        try {
          await removeTaxonomy({ kind, id: c.id });
          toast(t('tax.toast.deleted'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'taxonomy.remove'); toastError(explainError(e)); }
      };
      const move = async (btn) => {
        const { id, dir } = btn.dataset;
        try {
          await moveCategory({ id, dir });
          items = await reloadItems(kind);
          paintResults();
          const again = ctx.el.querySelector(`[data-action="move"][data-dir="${dir}"][data-id="${id}"]`);
          const other = ctx.el.querySelector(`[data-action="move"][data-dir="${dir === 'up' ? 'down' : 'up'}"][data-id="${id}"]`);
          (again && !again.disabled ? again : other)?.focus();          // keep the keyboard where it was
        } catch (e) { if (!isRefusal(e)) reportError(e, 'taxonomy.move'); toastError(explainError(e)); }
      };

      ctx.cleanup(bindActions(ctx.el, {
        add: () => openItem({}),
        move,
        'row-menu': (btn) => {
          const c = items.find((x) => x.id === btn.dataset.id);
          if (!c) return;
          const n = taxonomyCounts(kind, items, products).get(c.id) || { products: 0, children: 0 };
          const menu = [{ label: t('tax.menu.edit'), icon: 'edit', onClick: () => openItem({ item: c }) }];
          if (kind === 'category' && !c.parentId) menu.push({ label: t('tax.menu.addSub'), icon: 'plus', onClick: () => openItem({ parentId: c.id }) });
          menu.push(isShown(c) ? { label: t('tax.menu.hide'), icon: 'eye-off', onClick: () => setShown(c, false) } : { label: t('tax.menu.show'), icon: 'eye', onClick: () => setShown(c, true) });
          if (!n.products && !n.children) menu.push({ label: t('tax.menu.delete'), icon: 'trash', danger: true, onClick: () => remove(c) });
          openMenu({ anchor: btn, items: menu });
        },
      }, {
        input: { q: debounce((el) => { state.q = el.value; paintResults(); }, 200) },
      }));
    });
  },
};
