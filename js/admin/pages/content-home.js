/*
 * Content → Home page. Permission: content.write (Super Admin, Store Admin, Product Manager).
 *
 * The home page is a list of SECTIONS (hero slider, promo banners, categories, product rows, brands, trust badges, text, newsletter). Each section can be shown or
 * hidden, moved up and down, edited and deleted; new ones are added from a menu (hero, trust badges and newsletter only once). Everything is edited in a draft: nothing
 * reaches visitors until Save. Saving re-checks the draft (a slide needs a usable picture, links must be usable …), stores the SANITISED sections and writes the audit log.
 * Rules of the game: shared/contentFlow.js + shared/contentModel.js. Nothing is typed into the page structure while the editor re-draws: input is handled by delegation.
 */
import { html, render, raw, bindActions, delegate, debounce, withBusy } from '../../core/dom.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { registerBoth, t, tn, pick } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { emptyState, spinnerBlock, toast, toastError, confirmDialog, openMenu, fieldHtml, loadCss } from '../../core/ui.js';
import { num, toDhakaInput, fromDhakaInput } from '../../core/format.js';
import { HOME_SECTION_TYPES, HOME_SECTION_TYPE_IDS, PRODUCT_SOURCES, TRUST_ICONS, LIMITS_HOME, newSection, cleanImage } from '../../shared/contentModel.js';
import { homeProblems } from '../../shared/contentFlow.js';
import { safeMount, pageHead, needs } from '../lib/ui.js';
import { pickFiles } from '../lib/images.js';
import { loadHomeDoc, saveHome, uploadHomeImage, pickerData } from '../data/content.js';

registerBoth({
  'chm.title': ['Home page', 'হোম পেজ'],
  'chm.sub': ['Choose what visitors see on the home page and in which order. Nothing goes live until you press Save.', 'হোম পেজে ভিজিটররা কী কী দেখবে এবং কোন ক্রমে — বেছে নিন। সংরক্ষণ চাপার আগে কিছুই লাইভ হয় না।'],
  'chm.view': ['View store', 'স্টোর দেখুন'],
  'chm.save': ['Save', 'সংরক্ষণ'],
  'chm.discard': ['Discard changes', 'পরিবর্তন বাতিল'],
  'chm.discard.title': ['Discard your changes?', 'পরিবর্তনগুলো বাতিল করবেন?'],
  'chm.discard.text': ['The home page goes back to what is saved.', 'হোম পেজ সংরক্ষিত অবস্থায় ফিরে যাবে।'],
  'chm.discard.confirm': ['Discard', 'বাতিল করুন'],
  'chm.unsaved': ['You have unsaved changes.', 'আপনার অসংরক্ষিত পরিবর্তন আছে।'],
  'chm.saved': ['Home page saved', 'হোম পেজ সংরক্ষিত হয়েছে'],
  'chm.nochange': ['Nothing has changed since the last save.', 'শেষ সংরক্ষণের পর কিছুই বদলায়নি।'],
  'chm.neverSaved': ['The home page has not been saved here yet. Visitors see this standard layout. Press Save to make it yours.', 'হোম পেজ এখানে এখনও সংরক্ষণ করা হয়নি। ভিজিটররা এই সাধারণ বিন্যাস দেখছেন। নিজের করতে সংরক্ষণ চাপুন।'],
  'chm.problems': ['Fix these before saving:', 'সংরক্ষণের আগে এগুলো ঠিক করুন:'],
  'chm.add': ['Add section', 'সেকশন যোগ করুন'],
  'chm.add.full': ['The home page can have at most {n} sections.', 'হোম পেজে সর্বোচ্চ {n}টি সেকশন থাকতে পারে।'],
  'chm.add.none': ['Every section type that can be used once is already on the page.', 'যেসব সেকশন একবারই ব্যবহার করা যায় সেগুলো সবই পেজে আছে।'],
  'chm.empty': ['The home page has no sections', 'হোম পেজে কোনো সেকশন নেই'],
  'chm.emptyText': ['Add a section to build the page. Saved empty, visitors see no sections at all.', 'পেজ বানাতে একটি সেকশন যোগ করুন। খালি সংরক্ষণ করলে ভিজিটররা কোনো সেকশনই দেখবেন না।'],
  'chm.list': ['Home page sections', 'হোম পেজের সেকশন'],
  'chm.sec.shown': ['Shown', 'দেখানো হবে'],
  'chm.sec.shownLabel': ['Show {name} on the home page', 'হোম পেজে {name} দেখান'],
  'chm.sec.hidden': ['Hidden', 'লুকানো'],
  'chm.sec.edit': ['Edit {name}', '{name} সম্পাদনা'],
  'chm.sec.up': ['Move up', 'উপরে নিন'],
  'chm.sec.down': ['Move down', 'নিচে নিন'],
  'chm.sec.delete': ['Delete section', 'সেকশন মুছুন'],
  'chm.sec.delete.title': ['Delete this section?', 'এই সেকশন মুছবেন?'],
  'chm.sec.delete.text': ['"{name}" leaves the home page when you save.', 'সংরক্ষণ করলে "{name}" হোম পেজ থেকে চলে যাবে।'],
  'chm.sec.title': ['Heading', 'শিরোনাম'],
  'chm.sec.titleHint': ['Shown above the section. Leave empty for none.', 'সেকশনের উপরে দেখানো হয়। না চাইলে খালি রাখুন।'],
  'chm.sum.slides_one': ['{n} slide', '{n}টি স্লাইড'],
  'chm.sum.slides_other': ['{n} slides', '{n}টি স্লাইড'],
  'chm.sum.banners_one': ['{n} banner', '{n}টি ব্যানার'],
  'chm.sum.banners_other': ['{n} banners', '{n}টি ব্যানার'],
  'chm.sum.points_one': ['{n} point', '{n}টি পয়েন্ট'],
  'chm.sum.points_other': ['{n} points', '{n}টি পয়েন্ট'],
  'chm.sum.picked_one': ['{n} hand-picked', '{n}টি বাছাই করা'],
  'chm.sum.picked_other': ['{n} hand-picked', '{n}টি বাছাই করা'],
  'chm.sum.auto': ['Automatic', 'স্বয়ংক্রিয়'],
  'chm.sum.limit': ['Up to {n}', 'সর্বোচ্চ {n}টি'],
  'chm.hero.autoplay': ['Change slides automatically', 'স্লাইড নিজে নিজে বদলাক'],
  'chm.hero.interval': ['Seconds per slide', 'প্রতি স্লাইডে সেকেন্ড'],
  'chm.slide': ['Slide', 'স্লাইড'],
  'chm.banner': ['Banner', 'ব্যানার'],
  'chm.point': ['Point', 'পয়েন্ট'],
  'chm.slide.add': ['Add slide', 'স্লাইড যোগ করুন'],
  'chm.banner.add': ['Add banner', 'ব্যানার যোগ করুন'],
  'chm.point.add': ['Add point', 'পয়েন্ট যোগ করুন'],
  'chm.item.up': ['Move {name} up', '{name} উপরে নিন'],
  'chm.item.down': ['Move {name} down', '{name} নিচে নিন'],
  'chm.item.delete': ['Remove {name}', '{name} সরান'],
  'chm.item.max': ['At most {n}.', 'সর্বোচ্চ {n}টি।'],
  'chm.f.image': ['Picture', 'ছবি'],
  'chm.f.imageHint': ['Upload a picture or paste a https:// address.', 'ছবি আপলোড করুন বা https:// ঠিকানা দিন।'],
  'chm.f.mobileImage': ['Phone picture (optional)', 'ফোনের ছবি (ঐচ্ছিক)'],
  'chm.f.title': ['Title', 'শিরোনাম'],
  'chm.f.text': ['Text', 'লেখা'],
  'chm.f.cta': ['Button text', 'বাটনের লেখা'],
  'chm.f.link': ['Link', 'লিংক'],
  'chm.f.linkHint': ['Start with / for a page of your shop (for example /shop) or https:// for another site.', 'আপনার শপের পেজের জন্য / দিয়ে (যেমন /shop) অথবা অন্য সাইটের জন্য https:// দিয়ে শুরু করুন।'],
  'chm.f.tone': ['Text colour on the picture', 'ছবির উপরের লেখার রং'],
  'chm.tone.dark': ['White text (dark picture)', 'সাদা লেখা (গাঢ় ছবি)'],
  'chm.tone.light': ['Dark text (light picture)', 'গাঢ় লেখা (হালকা ছবি)'],
  'chm.f.alt': ['Picture description (for screen readers)', 'ছবির বর্ণনা (স্ক্রিন রিডারের জন্য)'],
  'chm.img.upload': ['Upload picture', 'ছবি আপলোড'],
  'chm.img.uploading': ['Uploading…', 'আপলোড হচ্ছে…'],
  'chm.img.clear': ['Remove picture', 'ছবি সরান'],
  'chm.img.preview': ['Preview', 'প্রিভিউ'],
  'chm.img.failed': ['The picture could not be uploaded.', 'ছবিটি আপলোড করা যায়নি।'],
  'chm.banners.columns': ['Banners per row', 'প্রতি সারিতে ব্যানার'],
  'chm.cat.limit': ['How many to show', 'কয়টি দেখাবে'],
  'chm.cat.style': ['Layout', 'বিন্যাস'],
  'chm.style.grid': ['Grid', 'গ্রিড'],
  'chm.style.scroll': ['Scrolling row', 'স্ক্রল করা সারি'],
  'chm.cat.pick': ['Hand-picked categories', 'বাছাই করা ক্যাটাগরি'],
  'chm.cat.pickHint': ['Leave all unticked to show the categories automatically.', 'সব অটিক রাখলে ক্যাটাগরি স্বয়ংক্রিয়ভাবে দেখানো হবে।'],
  'chm.cat.none': ['There are no categories yet.', 'এখনও কোনো ক্যাটাগরি নেই।'],
  'chm.prod.source': ['Which products', 'কোন প্রোডাক্ট'],
  'chm.prod.category': ['Category', 'ক্যাটাগরি'],
  'chm.prod.pickCategory': ['Choose a category…', 'একটি ক্যাটাগরি বাছুন…'],
  'chm.prod.limit': ['How many to show', 'কয়টি দেখাবে'],
  'chm.prod.viewAll': ['"View all" link', '"সব দেখুন" লিংক'],
  'chm.prod.endsAt': ['Offer ends (optional)', 'অফার শেষ (ঐচ্ছিক)'],
  'chm.prod.endsHint': ['Shows a countdown on this section until then (Bangladesh time).', 'এই সময় পর্যন্ত সেকশনে কাউন্টডাউন দেখায় (বাংলাদেশ সময়)।'],
  'chm.prod.pick': ['Hand-picked products', 'বাছাই করা প্রোডাক্ট'],
  'chm.prod.search': ['Search by name or SKU to add', 'যোগ করতে নাম বা SKU দিয়ে খুঁজুন'],
  'chm.prod.none': ['No product matches.', 'কোনো প্রোডাক্ট মেলেনি।'],
  'chm.prod.add': ['Add {name}', '{name} যোগ করুন'],
  'chm.prod.remove': ['Remove {name}', '{name} সরান'],
  'chm.prod.chosen': ['Chosen ({n})', 'বাছাই করা ({n})'],
  'chm.prod.missing': ['{id} (no longer in the shop)', '{id} (আর শপে নেই)'],
  'chm.brands.limit': ['How many brands to show', 'কয়টি ব্র্যান্ড দেখাবে'],
  'chm.trust.icon': ['Icon', 'আইকন'],
  'chm.rich.body': ['Text', 'লেখা'],
  'chm.rich.hint': ['Markdown: # heading, **bold**, - list, [link](https://…)', 'Markdown: # শিরোনাম, **গাঢ়**, - তালিকা, [লিংক](https://…)'],
  'chm.rich.align': ['Alignment', 'সাজানো'],
  'chm.align.start': ['Left', 'বামে'],
  'chm.align.center': ['Centre', 'মাঝখানে'],
  'chm.news.text': ['Text above the box', 'বক্সের উপরের লেখা'],
  'chm.icon.truck': ['Delivery', 'ডেলিভারি'], 'chm.icon.shield-check': ['Shield', 'নিরাপত্তা'], 'chm.icon.undo': ['Returns', 'রিটার্ন'], 'chm.icon.wallet': ['Wallet', 'ওয়ালেট'],
  'chm.icon.headset': ['Support', 'সাপোর্ট'], 'chm.icon.gift': ['Gift', 'উপহার'], 'chm.icon.award': ['Award', 'পুরস্কার'], 'chm.icon.clock': ['Clock', 'ঘড়ি'],
  'chm.icon.credit-card': ['Card', 'কার্ড'], 'chm.icon.smartphone': ['Phone', 'ফোন'],
});

/** one line of readable text out of a Markdown snippet (for the card summary) */
const plain = (md, max) => {
  const t0 = String(md || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[\s>#*-]+/gm, '').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
  return t0.length > max ? `${t0.slice(0, max).trimEnd()}…` : t0;
};
const typeName = (type) => pick(HOME_SECTION_TYPES[type].en, HOME_SECTION_TYPES[type].bn);
const typeAbout = (type) => pick(...HOME_SECTION_TYPES[type].about);
const clone = (v) => JSON.parse(JSON.stringify(v));
const readsAsSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** list sections: which array holds the items, what one is called, the most allowed, and an empty one */
const LISTS = {
  hero: { key: 'slides', noun: 'chm.slide', add: 'chm.slide.add', max: LIMITS_HOME.MAX_SLIDES, blank: () => ({ id: `h${Math.random().toString(36).slice(2, 8)}`, image: '', mobileImage: '', title: '', text: '', cta: '', link: '', tone: 'dark', alt: '' }) },
  banners: { key: 'items', noun: 'chm.banner', add: 'chm.banner.add', max: LIMITS_HOME.MAX_BANNERS, blank: () => ({ id: `b${Math.random().toString(36).slice(2, 8)}`, image: '', title: '', text: '', cta: '', link: '', alt: '' }) },
  trust: { key: 'items', noun: 'chm.point', add: 'chm.point.add', max: LIMITS_HOME.MAX_TRUST, blank: () => ({ icon: 'shield-check', title: '', text: '' }) },
};

function categoryTree(cats) {
  const byParent = new Map();
  for (const c of cats) { const k = c.parentId || ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(c); }
  const out = [];
  const walk = (pid, depth) => {
    for (const c of (byParent.get(pid) || []).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      out.push({ id: c.id, label: `${depth ? '— ' : ''}${c.name}` });
      if (depth < 4) walk(c.id, depth + 1);
    }
  };
  walk('', 0);
  for (const c of cats) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, label: c.name });
  return out;
}

export default {
  async mount(ctx) {
    if (!needs(ctx, 'content.write')) return;
    await loadCss('/css/pages/admin-content.css');
    await safeMount(ctx, async () => {
      const [doc, scope] = await Promise.all([loadHomeDoc(), pickerData().catch(() => ({ products: [], categories: [] }))]);
      if (ctx.signal.aborted) return;
      let baseline = clone(doc.sections);
      let draft = clone(doc.sections);
      let exists = doc.exists;
      let dirty = false;
      let showProblems = false;
      const open = new Set();
      const cats = categoryTree(scope.categories || []);
      const catName = (id) => { const c = (scope.categories || []).find((x) => x.id === id); return c ? c.name : id; };
      const prodOf = (id) => (scope.products || []).find((p) => p.id === id);
      const host = (sel) => ctx.el.querySelector(sel);
      const sec = (id) => draft.find((s) => s.id === id);
      const idx = (id) => draft.findIndex((s) => s.id === id);

      /* ───────── summaries ───────── */
      const summaryOf = (s) => {
        switch (s.type) {
          case 'hero': return tn('chm.sum.slides', s.slides.length, { n: num(s.slides.length) });
          case 'banners': return tn('chm.sum.banners', s.items.length, { n: num(s.items.length) });
          case 'trust': return tn('chm.sum.points', s.items.length, { n: num(s.items.length) });
          case 'categories': return s.categoryIds.length ? tn('chm.sum.picked', s.categoryIds.length, { n: num(s.categoryIds.length) }) : `${t('chm.sum.auto')} · ${t('chm.sum.limit', { n: num(s.limit) })}`;
          case 'products': {
            const src = PRODUCT_SOURCES[s.source];
            const base = src ? pick(src.en, src.bn) : '';
            if (s.source === 'category') return `${base}${s.categoryId ? ` · ${catName(s.categoryId)}` : ''}`;
            if (s.source === 'manual') return `${base} · ${num(s.productIds.length)}`;
            return `${base} · ${t('chm.sum.limit', { n: num(s.limit) })}`;
          }
          case 'brands': return t('chm.sum.limit', { n: num(s.limit) });
          case 'richText': return plain(s.body, 60);
          case 'newsletter': return plain(s.text, 60);
          default: return '';
        }
      };

      /* ───────── field builders ───────── */
      const dataAttrs = (s, f, coerce, list, i) => ({ 'data-s': s.id, 'data-f': f, 'data-t': coerce, ...(list ? { 'data-list': list, 'data-i': i } : {}) });
      const nameOf = (s, f, list, i) => `${s.id}-${list ? `${list}${i}-` : ''}${f}`;
      const F = (s, f, o = {}) => {
        const { list, i, label, type = 'text', value = (list ? s[list][i][f] : s[f]), hint, options, rows, coerce = 'text', attrs = {} } = o;
        return fieldHtml({ name: nameOf(s, f, list, i), label, type, value: value ?? '', hint, options, rows, attrs: { ...dataAttrs(s, f, coerce, list, i), ...attrs } });
      };
      const INT = (s, f, label, min, max, o = {}) => F(s, f, { label, type: 'number', coerce: 'int', attrs: { min, max, inputmode: 'numeric' }, ...o });
      const SELECT = (s, f, label, options, o = {}) => F(s, f, { label, type: 'select', options, ...o });
      const SWITCH = (s, f, label, o = {}) => F(s, f, { label, type: 'switch', coerce: 'bool', ...o });

      const IMG = (s, f, label, o = {}) => {
        const { list, i, hint } = o;
        const value = (list ? s[list][i][f] : s[f]) || '';
        const ok = cleanImage(value);
        const dl = list || '';
        const di = list ? i : '';
        return html`<div class="chm-img">
          <div class="chm-thumb" aria-hidden="true">${ok ? html`<img src="${ok}" alt="" loading="lazy" decoding="async">` : icon('image', { size: 24 })}</div>
          <div class="chm-img-main">
            ${fieldHtml({ name: nameOf(s, f, list, i), label, type: 'text', value, hint, placeholder: 'https://…', attrs: { ...dataAttrs(s, f, 'text', list, i), inputmode: 'url', autocomplete: 'off' } })}
            <div class="row chm-img-btns">
              <button type="button" class="btn btn-sm" data-action="img-up" data-s="${s.id}" data-f="${f}" data-list="${dl}" data-i="${di}">${icon('upload', { size: 16 })}<span>${t('chm.img.upload')}</span></button>
              ${value ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="img-clear" data-s="${s.id}" data-f="${f}" data-list="${dl}" data-i="${di}">${icon('x', { size: 16 })}<span>${t('chm.img.clear')}</span></button>` : ''}
            </div>
          </div>
        </div>`;
      };

      const itemBlock = (s, L, i, inner) => {
        const list = L.key;
        const name = `${t(L.noun)} ${num(i + 1)}`;
        const n = s[list].length;
        return html`<fieldset class="chm-item"><legend class="sr-only">${name}</legend>
          <div class="chm-item-head"><strong>${name}</strong>
            <div class="chm-item-ctl">
              <button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="item-up" data-s="${s.id}" data-list="${list}" data-i="${i}" aria-label="${t('chm.item.up', { name })}" ${i === 0 ? raw('disabled') : ''}>${icon('arrow-up', { size: 16 })}</button>
              <button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="item-down" data-s="${s.id}" data-list="${list}" data-i="${i}" aria-label="${t('chm.item.down', { name })}" ${i === n - 1 ? raw('disabled') : ''}>${icon('arrow-down', { size: 16 })}</button>
              <button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="item-del" data-s="${s.id}" data-list="${list}" data-i="${i}" aria-label="${t('chm.item.delete', { name })}">${icon('trash', { size: 16 })}</button>
            </div></div>
          <div class="chm-grid">${inner}</div></fieldset>`;
      };
      const listBlock = (s, L, innerOf) => html`<div class="chm-items">${s[L.key].map((item, i) => itemBlock(s, L, i, innerOf(item, i)))}
        <div class="row chm-add-item"><button type="button" class="btn btn-sm" data-action="item-add" data-s="${s.id}" data-list="${L.key}" ${s[L.key].length >= L.max ? raw('disabled') : ''}>${icon('plus', { size: 16 })}<span>${t(L.add)}</span></button>
          ${s[L.key].length >= L.max ? html`<span class="muted small">${t('chm.item.max', { n: num(L.max) })}</span>` : ''}</div></div>`;

      /* ───────── bodies per type ───────── */
      const body = (s) => {
        const common = F(s, 'title', { label: t('chm.sec.title'), hint: t('chm.sec.titleHint'), attrs: { maxlength: 80 } });
        switch (s.type) {
          case 'hero': return html`${common}<div class="chm-grid">${SWITCH(s, 'autoplay', t('chm.hero.autoplay'))}${INT(s, 'interval', t('chm.hero.interval'), 3, 15)}</div>
            ${listBlock(s, LISTS.hero, (x, i) => html`
              <div class="span-2">${IMG(s, 'image', t('chm.f.image'), { list: 'slides', i, hint: t('chm.f.imageHint') })}</div>
              <div class="span-2">${IMG(s, 'mobileImage', t('chm.f.mobileImage'), { list: 'slides', i })}</div>
              ${F(s, 'title', { list: 'slides', i, label: t('chm.f.title'), attrs: { maxlength: 90 } })}
              ${F(s, 'cta', { list: 'slides', i, label: t('chm.f.cta'), attrs: { maxlength: 30 } })}
              <div class="span-2">${F(s, 'text', { list: 'slides', i, label: t('chm.f.text'), attrs: { maxlength: 200 } })}</div>
              <div class="span-2">${F(s, 'link', { list: 'slides', i, label: t('chm.f.link'), hint: t('chm.f.linkHint'), attrs: { maxlength: 500, inputmode: 'url' } })}</div>
              ${SELECT(s, 'tone', t('chm.f.tone'), [{ value: 'dark', label: t('chm.tone.dark') }, { value: 'light', label: t('chm.tone.light') }], { list: 'slides', i })}
              ${F(s, 'alt', { list: 'slides', i, label: t('chm.f.alt'), attrs: { maxlength: 140 } })}`)}`;
          case 'banners': return html`${common}${SELECT(s, 'columns', t('chm.banners.columns'), [1, 2, 3].map((n) => ({ value: n, label: num(n) })), { coerce: 'int' })}
            ${listBlock(s, LISTS.banners, (x, i) => html`
              <div class="span-2">${IMG(s, 'image', t('chm.f.image'), { list: 'items', i, hint: t('chm.f.imageHint') })}</div>
              ${F(s, 'title', { list: 'items', i, label: t('chm.f.title'), attrs: { maxlength: 70 } })}
              ${F(s, 'cta', { list: 'items', i, label: t('chm.f.cta'), attrs: { maxlength: 30 } })}
              <div class="span-2">${F(s, 'text', { list: 'items', i, label: t('chm.f.text'), attrs: { maxlength: 140 } })}</div>
              <div class="span-2">${F(s, 'link', { list: 'items', i, label: t('chm.f.link'), hint: t('chm.f.linkHint'), attrs: { maxlength: 500, inputmode: 'url' } })}</div>
              <div class="span-2">${F(s, 'alt', { list: 'items', i, label: t('chm.f.alt'), attrs: { maxlength: 140 } })}</div>`)}`;
          case 'categories': return html`${common}<div class="chm-grid">${INT(s, 'limit', t('chm.cat.limit'), 1, 24)}${SELECT(s, 'style', t('chm.cat.style'), [{ value: 'grid', label: t('chm.style.grid') }, { value: 'scroll', label: t('chm.style.scroll') }])}</div>
            <div class="field"><span class="chm-label" id="chm-cp-${s.id}">${t('chm.cat.pick')}</span>
              <div class="chm-checks" role="group" aria-labelledby="chm-cp-${s.id}">${cats.length ? cats.map((c) => html`<label class="check"><input type="checkbox" data-pick="categoryIds" data-s="${s.id}" data-id="${c.id}" ${s.categoryIds.includes(c.id) ? raw('checked') : ''}><span>${c.label}</span></label>`) : html`<p class="muted small">${t('chm.cat.none')}</p>`}</div>
              <div class="field-hint">${t('chm.cat.pickHint')}</div></div>`;
          case 'products': return html`${common}<div class="chm-grid">
              ${SELECT(s, 'source', t('chm.prod.source'), Object.entries(PRODUCT_SOURCES).map(([value, m]) => ({ value, label: pick(m.en, m.bn) })), { attrs: { 'data-repaint': '1' } })}
              ${s.source === 'category' ? SELECT(s, 'categoryId', t('chm.prod.category'), [{ value: '', label: t('chm.prod.pickCategory') }, ...cats.map((c) => ({ value: c.id, label: c.label }))], { attrs: { 'data-refresh': '1' } }) : ''}
              ${s.source !== 'manual' ? INT(s, 'limit', t('chm.prod.limit'), 1, LIMITS_HOME.MAX_PRODUCTS) : ''}
              <div class="span-2">${F(s, 'viewAllLink', { label: t('chm.prod.viewAll'), hint: t('chm.f.linkHint'), attrs: { maxlength: 500, inputmode: 'url' } })}</div>
              <div class="span-2">${F(s, 'endsAt', { label: t('chm.prod.endsAt'), hint: t('chm.prod.endsHint'), type: 'datetime-local', coerce: 'ms', value: s.endsAt ? toDhakaInput(s.endsAt) : '' })}</div></div>
            ${s.source === 'manual' ? html`<div class="field chm-pick"><span class="chm-label">${t('chm.prod.chosen', { n: num(s.productIds.length) })}</span>
              <ul class="chm-chosen">${s.productIds.map((pid) => { const p = prodOf(pid); const nm = p ? p.name : t('chm.prod.missing', { id: pid }); return html`<li><span>${nm}</span><button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="pick-del" data-s="${s.id}" data-id="${pid}" aria-label="${t('chm.prod.remove', { name: nm })}">${icon('x', { size: 16 })}</button></li>`; })}</ul>
              ${F(s, 'q', { label: t('chm.prod.pick'), type: 'search', value: '', hint: t('chm.prod.search'), attrs: { 'data-pick-q': s.id, 'data-f': 'q', autocomplete: 'off' } })}
              <ul class="chm-results" id="chm-res-${s.id}"></ul></div>` : ''}`;
          case 'brands': return html`${common}${INT(s, 'limit', t('chm.brands.limit'), 1, 24)}`;
          case 'trust': return html`${common}${listBlock(s, LISTS.trust, (x, i) => html`
              ${SELECT(s, 'icon', t('chm.trust.icon'), TRUST_ICONS.map((v) => ({ value: v, label: t(`chm.icon.${v}`) })), { list: 'items', i })}
              ${F(s, 'title', { list: 'items', i, label: t('chm.f.title'), attrs: { maxlength: 60 } })}
              <div class="span-2">${F(s, 'text', { list: 'items', i, label: t('chm.f.text'), attrs: { maxlength: 140 } })}</div>`)}`;
          case 'richText': return html`${common}${F(s, 'body', { label: t('chm.rich.body'), type: 'textarea', rows: 6, hint: t('chm.rich.hint'), attrs: { maxlength: 4000 } })}
            ${SELECT(s, 'align', t('chm.rich.align'), [{ value: 'start', label: t('chm.align.start') }, { value: 'center', label: t('chm.align.center') }])}`;
          case 'newsletter': return html`${common}${F(s, 'text', { label: t('chm.news.text'), attrs: { maxlength: 200 } })}`;
          default: return '';
        }
      };

      /* ───────── cards ───────── */
      const card = (s, i) => {
        const name = typeName(s.type);
        const isOpen = open.has(s.id);
        return html`<li class="chm-sec ${s.enabled ? '' : 'is-off'}" data-id="${s.id}" data-type="${s.type}">
          <div class="chm-sec-head">
            <button type="button" class="chm-toggle" data-action="toggle" data-id="${s.id}" aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="chm-body-${s.id}" aria-label="${t('chm.sec.edit', { name })}">
              <span class="chm-ico" aria-hidden="true">${icon(HOME_SECTION_TYPES[s.type].icon, { size: 20 })}</span>
              <span class="chm-t"><strong>${name}${s.title ? html` <span class="chm-ttl">— ${s.title}</span>` : ''}</strong><span class="chm-s" id="chm-sum-${s.id}">${summaryOf(s) || typeAbout(s.type)}</span></span>
              <span class="chm-chev" aria-hidden="true">${icon('chevron-down', { size: 18 })}</span>
            </button>
            <label class="switch chm-enabled"><input type="checkbox" role="switch" data-s="${s.id}" data-f="enabled" data-t="bool" ${s.enabled ? raw('checked') : ''} aria-label="${t('chm.sec.shownLabel', { name })}"><span class="track"></span><span class="chm-en-t">${s.enabled ? t('chm.sec.shown') : t('chm.sec.hidden')}</span></label>
            <div class="chm-ctl">
              <button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="up" data-id="${s.id}" aria-label="${t('chm.sec.up')}: ${name}" ${i === 0 ? raw('disabled') : ''}>${icon('arrow-up', { size: 16 })}</button>
              <button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="down" data-id="${s.id}" aria-label="${t('chm.sec.down')}: ${name}" ${i === draft.length - 1 ? raw('disabled') : ''}>${icon('arrow-down', { size: 16 })}</button>
              <button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="del" data-id="${s.id}" aria-label="${t('chm.sec.delete')}: ${name}">${icon('trash', { size: 16 })}</button>
            </div>
          </div>
          <div class="chm-sec-body stack" id="chm-body-${s.id}" ${isOpen ? '' : raw('hidden')}>${isOpen ? body(s) : ''}</div>
        </li>`;
      };
      const listHtml = () => (draft.length
        ? html`<ol class="chm-list" aria-label="${t('chm.list')}">${draft.map(card)}</ol>`
        : emptyState({ icon: 'grid', title: t('chm.empty'), text: t('chm.emptyText') }));
      const paintList = () => render(host('#chm-list'), listHtml());
      const paintCard = (id) => { const li = host(`.chm-sec[data-id="${id}"]`); if (!li) return paintList(); const i = idx(id); const tmp = document.createElement('div'); render(tmp, card(sec(id), i)); li.replaceWith(tmp.firstElementChild); };
      const focusSel = (sel) => { const el = host(sel); if (el) el.focus(); };

      const problemsHtml = () => {
        if (!showProblems) return '';
        const list = homeProblems(draft);
        return list.length ? html`<div class="alert alert-bad" role="alert" id="chm-problems" tabindex="-1">${icon('alert-triangle', { size: 18 })}<div><strong>${t('chm.problems')}</strong><ul class="chm-problem-list">${list.map((p) => html`<li>${pick(p[0], p[1])}</li>`)}</ul></div></div>` : '';
      };
      const paintProblems = () => render(host('#chm-notice'), html`${exists ? '' : html`<div class="alert alert-info" role="note" id="chm-never">${icon('info', { size: 18 })}<div>${t('chm.neverSaved')}</div></div>`}${problemsHtml()}`);
      const paintBar = () => {
        const msg = host('#chm-dirty'); if (msg) msg.textContent = dirty ? t('chm.unsaved') : '';
        for (const b of ctx.el.querySelectorAll('[data-action="save"], [data-action="discard"]')) b.disabled = !dirty && (b.dataset.action === 'discard' || exists);
      };
      const markDirty = () => { dirty = !readsAsSame(draft, baseline); paintBar(); if (showProblems) paintProblems(); };

      render(ctx.el, html`<div class="chm">
        ${pageHead({ title: t('chm.title'), sub: t('chm.sub'), actions: html`<a class="btn" href="/" target="_blank" rel="noopener">${icon('external-link', { size: 18 })}<span>${t('chm.view')}</span></a>` })}
        <div id="chm-notice" class="stack"></div>
        <div id="chm-list"></div>
        <div class="chm-addrow"><button type="button" class="btn" data-action="add" id="chm-add">${icon('plus', { size: 18 })}<span>${t('chm.add')}</span></button><span class="muted small" id="chm-addnote" role="status"></span></div>
        <div class="sticky-bar chm-bar"><span class="muted small" id="chm-dirty" role="status"></span>
          <div class="row"><button type="button" class="btn" data-action="discard">${t('chm.discard')}</button><button type="button" class="btn btn-primary" data-action="save">${icon('check', { size: 18 })}<span>${t('chm.save')}</span></button></div></div></div>`);
      paintList(); paintProblems(); paintBar();

      const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
      window.addEventListener('beforeunload', beforeUnload);
      ctx.cleanup(() => window.removeEventListener('beforeunload', beforeUnload));

      /* ───────── editing: one delegated listener for typing, ticking and choosing ───────── */
      const apply = (el) => {
        const s = sec(el.dataset.s);
        if (!s || !el.dataset.f || el.dataset.f === 'q') return;
        const target = el.dataset.list ? (s[el.dataset.list] || [])[Number(el.dataset.i)] : s;
        if (!target) return;
        const kind = el.dataset.t || 'text';
        let v;
        if (kind === 'bool') v = el.checked;
        else if (kind === 'int') v = el.value === '' ? '' : Number(el.value);
        else if (kind === 'ms') v = el.value ? fromDhakaInput(el.value) : null;
        else v = el.value;
        target[el.dataset.f] = v;
        markDirty();
        const sum = host(`#chm-sum-${s.id}`);
        if (sum) sum.textContent = summaryOf(s) || typeAbout(s.type);
        if (el.dataset.f === 'enabled') { paintCard(s.id); focusSel(`.chm-sec[data-id="${s.id}"] [data-f="enabled"]`); }
        else if (el.dataset.f === 'title' && !el.dataset.list) { const strong = host(`.chm-sec[data-id="${s.id}"] .chm-t strong`); if (strong) render(strong, html`${typeName(s.type)}${s.title ? html` <span class="chm-ttl">— ${s.title}</span>` : ''}`); }
        if (el.dataset.repaint) { paintCard(s.id); focusSel(`#f-${nameOf(s, el.dataset.f)}`); }
        if (el.dataset.f === 'image' || el.dataset.f === 'mobileImage') {
          const box = el.closest('.chm-img'); const thumb = box && box.querySelector('.chm-thumb');
          if (thumb) { const ok = cleanImage(v); render(thumb, ok ? html`<img src="${ok}" alt="" loading="lazy" decoding="async">` : icon('image', { size: 24 })); }
        }
      };
      const on = (type, selector, fn) => ctx.cleanup(delegate(ctx.el, type, selector, (ev, el) => fn(el, ev)));
      on('input', 'input[data-f]:not([type="checkbox"]), textarea[data-f]', apply);
      on('change', 'select[data-f], input[type="checkbox"][data-f]', apply);
      on('change', 'input[data-pick="categoryIds"]', (el) => {
        const s = sec(el.dataset.s); if (!s) return;
        const set = new Set(s.categoryIds);
        if (el.checked) set.add(el.dataset.id); else set.delete(el.dataset.id);
        s.categoryIds = [...set];
        markDirty();
        const sum = host(`#chm-sum-${s.id}`); if (sum) sum.textContent = summaryOf(s);
      });
      // typing in a product search lists matches (nothing is stored until one is added)
      const searchProducts = debounce((el) => {
        const s = sec(el.dataset.pickQ); const out = host(`#chm-res-${el.dataset.pickQ}`);
        if (!s || !out) return;
        const needle = el.value.trim().toLowerCase();
        const rows = needle ? (scope.products || []).filter((p) => !s.productIds.includes(p.id) && (`${p.name} ${p.sku}`).toLowerCase().includes(needle)).slice(0, 8) : [];
        render(out, needle ? (rows.length ? html`${rows.map((p) => html`<li><span>${p.name}${p.sku ? html` <span class="muted small">${p.sku}</span>` : ''}</span><button type="button" class="btn btn-sm" data-action="pick-add" data-s="${s.id}" data-id="${p.id}" aria-label="${t('chm.prod.add', { name: p.name })}">${icon('plus', { size: 16 })}</button></li>`)}` : html`<li class="muted small">${t('chm.prod.none')}</li>`) : '');
      }, 150);
      on('input', 'input[data-pick-q]', (el) => searchProducts(el));

      /* ───────── actions ───────── */
      const moveIn = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return false; [arr[i], arr[j]] = [arr[j], arr[i]]; return true; };
      const itemOf = (el) => { const s = sec(el.dataset.s); const list = s && s[el.dataset.list]; return { s, list, i: Number(el.dataset.i) }; };
      const refreshAddNote = () => { const n = host('#chm-addnote'); if (n) n.textContent = draft.length >= LIMITS_HOME.MAX_SECTIONS ? t('chm.add.full', { n: num(LIMITS_HOME.MAX_SECTIONS) }) : ''; };

      const addSection = (type) => {
        if (draft.length >= LIMITS_HOME.MAX_SECTIONS) return;
        const s = newSection(type);
        draft.push(s); open.add(s.id);
        paintList(); markDirty(); refreshAddNote();
        const li = host(`.chm-sec[data-id="${s.id}"]`);
        if (li) { li.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); const first = li.querySelector('input, select, textarea'); if (first) first.focus({ preventScroll: true }); }
      };

      const act = {
        toggle: (el) => { const id = el.dataset.id; if (open.has(id)) open.delete(id); else open.add(id); paintCard(id); focusSel(`.chm-sec[data-id="${id}"] [data-action="toggle"]`); },
        up: (el) => { if (moveIn(draft, idx(el.dataset.id), -1)) { paintList(); markDirty(); focusSel(`[data-action="up"][data-id="${el.dataset.id}"]:not([disabled]), [data-action="down"][data-id="${el.dataset.id}"]`); } },
        down: (el) => { if (moveIn(draft, idx(el.dataset.id), 1)) { paintList(); markDirty(); focusSel(`[data-action="down"][data-id="${el.dataset.id}"]:not([disabled]), [data-action="up"][data-id="${el.dataset.id}"]`); } },
        del: async (el) => {
          const s = sec(el.dataset.id); if (!s) return;
          const yes = await confirmDialog({ title: t('chm.sec.delete.title'), message: t('chm.sec.delete.text', { name: typeName(s.type) }), confirmText: t('chm.sec.delete'), danger: true });
          if (!yes) return;
          draft = draft.filter((x) => x.id !== s.id); open.delete(s.id);
          paintList(); markDirty(); refreshAddNote(); focusSel('#chm-add');
        },
        add: (el) => {
          if (draft.length >= LIMITS_HOME.MAX_SECTIONS) { toast(t('chm.add.full', { n: num(LIMITS_HOME.MAX_SECTIONS) })); return; }
          const used = new Set(draft.map((s) => s.type));
          const items = HOME_SECTION_TYPE_IDS.filter((type) => HOME_SECTION_TYPES[type].multi || !used.has(type)).map((type) => ({ label: typeName(type), icon: HOME_SECTION_TYPES[type].icon, onClick: () => addSection(type) }));
          if (!items.length) { toast(t('chm.add.none')); return; }
          openMenu({ anchor: el, items, align: 'start' });
        },
        'item-add': (el) => { const s = sec(el.dataset.s); const L = s && LISTS[s.type]; if (!L || s[L.key].length >= L.max) return; s[L.key].push(L.blank()); paintCard(s.id); markDirty(); const li = host(`.chm-sec[data-id="${s.id}"]`); const last = li && [...li.querySelectorAll('.chm-item')].pop(); const f = last && last.querySelector('input:not([type="hidden"])'); if (f) f.focus(); },
        'item-del': (el) => { const { s, list, i } = itemOf(el); if (!list) return; list.splice(i, 1); paintCard(s.id); markDirty(); focusSel(`.chm-sec[data-id="${s.id}"] [data-action="item-add"]`); },
        'item-up': (el) => { const { s, list, i } = itemOf(el); if (list && moveIn(list, i, -1)) { paintCard(s.id); markDirty(); focusSel(`.chm-sec[data-id="${s.id}"] [data-action="item-up"][data-i="${i - 1}"]:not([disabled]), .chm-sec[data-id="${s.id}"] [data-action="item-down"][data-i="${i - 1}"]`); } },
        'item-down': (el) => { const { s, list, i } = itemOf(el); if (list && moveIn(list, i, 1)) { paintCard(s.id); markDirty(); focusSel(`.chm-sec[data-id="${s.id}"] [data-action="item-down"][data-i="${i + 1}"]:not([disabled]), .chm-sec[data-id="${s.id}"] [data-action="item-up"][data-i="${i + 1}"]`); } },
        'img-clear': (el) => { const s = sec(el.dataset.s); if (!s) return; const target = el.dataset.list ? s[el.dataset.list][Number(el.dataset.i)] : s; target[el.dataset.f] = ''; paintCard(s.id); markDirty(); },
        'img-up': async (el) => {
          const s = sec(el.dataset.s); if (!s) return;
          const files = await pickFiles({ multiple: false });
          if (!files || !files.length) return;
          const label = el.querySelector('span');
          const was = label ? label.textContent : '';
          el.disabled = true; if (label) label.textContent = t('chm.img.uploading');
          try {
            const up = await uploadHomeImage(files[0]);
            const target = el.dataset.list ? s[el.dataset.list][Number(el.dataset.i)] : s;
            if (target && sec(s.id)) { target[el.dataset.f] = up.url; paintCard(s.id); markDirty(); }
          } catch (e) { toastError(e && e.message ? e.message : t('chm.img.failed')); el.disabled = false; if (label) label.textContent = was; }
        },
        'pick-add': (el) => { const s = sec(el.dataset.s); if (!s || s.productIds.includes(el.dataset.id) || s.productIds.length >= LIMITS_HOME.MAX_PRODUCTS) return; s.productIds.push(el.dataset.id); paintCard(s.id); markDirty(); focusSel(`#f-${nameOf(s, 'q')}`); },
        'pick-del': (el) => { const s = sec(el.dataset.s); if (!s) return; s.productIds = s.productIds.filter((x) => x !== el.dataset.id); paintCard(s.id); markDirty(); },
        discard: async () => {
          if (!dirty) return;
          if (!(await confirmDialog({ title: t('chm.discard.title'), message: t('chm.discard.text'), confirmText: t('chm.discard.confirm'), danger: true }))) return;
          draft = clone(baseline); dirty = false; showProblems = false; open.clear();
          paintList(); paintProblems(); paintBar(); refreshAddNote();
        },
        save: async (el) => {
          showProblems = true; paintProblems();
          if (homeProblems(draft).length) { focusSel('#chm-problems'); return; }
          try {
            const stored = await withBusy(el, () => saveHome(draft));
            baseline = clone(stored); draft = clone(stored); exists = true; dirty = false; showProblems = false;
            paintList(); paintProblems(); paintBar(); refreshAddNote();
            toast(t('chm.saved'));
          } catch (e) {
            if (e && e.code === 'no_change') {
              draft = clone(baseline); exists = true; dirty = false; showProblems = false;
              paintList(); paintProblems(); paintBar(); toast(t('chm.nochange'));
            } else if (e && e.problems) { showProblems = true; paintProblems(); focusSel('#chm-problems'); }
            else { if (!isRefusal(e)) reportError(e, 'content.home'); toastError(explainError(e)); }
          }
        },
      };
      ctx.cleanup(bindActions(ctx.el, act));
      refreshAddNote();
    });
  },
};
