/*
 * Product editor — create (#/products/new, optionally ?from=<id> to duplicate) and edit (#/products/<id>).
 *
 * One form, nine sections: basics · organisation · images · pricing · inventory · variants · details · SEO · private cost.
 * The page only collects input; js/shared/productFlow.js validates and plans the writes (product, inventory documents, SKU / slug index,
 * catalog stamp, audit entry) and js/admin/data/products.js commits them. Field errors come back as codes and are shown under the fields.
 *
 * Stock of an EXISTING unit is shown read-only here: it changes on the Inventory page, which logs every change and cannot overwrite what
 * customers reserved in the meantime. A new product (or a new variant) takes its starting stock here.
 * Variants that exist cannot be deleted (old orders refer to them), only switched off.
 * Old-format products (created on the old site) are not editable until the migration has upgraded them.
 */
import { html, render, bindActions, readForm, withBusy, raw, safeUrl, aria } from '../../core/dom.js';
import { registerBoth, t, tn, lbl } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { emptyState, fieldHtml, toast, toastError, confirmDialog, badge } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, toDhakaInput, fromDhakaInput } from '../../core/format.js';
import { can } from '../../data/auth.js';
import { PRODUCT_STATUS, LIMITS } from '../../shared/constants.js';
import { slugify } from '../../shared/slug.js';
import { shortId, lineKey } from '../../shared/id.js';
import { renderMarkdown } from '../../shared/markdown.js';
import { toMillis } from '../../shared/pricing.js';
import { isLegacyProduct } from '../../shared/productModel.js';
import { PRODUCT_LIMITS } from '../../shared/productFlow.js';
import { safeMount, needs } from '../lib/ui.js';
import { loadAdminCatalog } from '../data/catalogAdmin.js';
import { loadProductForEdit, saveProduct, newProductId } from '../data/products.js';
import { uploadProductImage, deleteProductImage, pickFiles } from '../lib/images.js';

registerBoth({
  'pe.back': ['Products', 'প্রোডাক্ট'],
  'pe.titleNew': ['New product', 'নতুন প্রোডাক্ট'],
  'pe.viewStore': ['View in store', 'স্টোরে দেখুন'],
  'pe.duplicate': ['Duplicate', 'ডুপ্লিকেট'],
  'pe.readonly': ['You can look at this product, but your role cannot change it.', 'আপনি এই প্রোডাক্ট দেখতে পারবেন, কিন্তু আপনার রোল দিয়ে বদলানো যাবে না।'],
  'pe.notFound': ['Product not found', 'প্রোডাক্ট পাওয়া যায়নি'],
  'pe.notFoundText': ['It may have been deleted.', 'এটি মুছে ফেলা হয়ে থাকতে পারে।'],
  'pe.legacyTitle': ['Old-format product', 'পুরনো ফরম্যাটের প্রোডাক্ট'],
  'pe.legacyText': ['This product was created on the old site. It is shown in the store, but it can only be edited after the migration (Setup page) has upgraded it.', 'এই প্রোডাক্টটি পুরনো সাইটে তৈরি। স্টোরে দেখা যাচ্ছে, কিন্তু মাইগ্রেশন (সেটআপ পেজ) চালিয়ে আপগ্রেড করার পরেই এডিট করা যাবে।'],
  'pe.legacyGo': ['Open the Setup page', 'সেটআপ পেজ খুলুন'],
  /* basics */
  'pe.basics': ['Basics', 'মূল তথ্য'],
  'pe.name': ['Product name', 'প্রোডাক্টের নাম'],
  'pe.slug': ['Web address (slug)', 'ওয়েব ঠিকানা (স্লাগ)'],
  'pe.slugHint': ['Lowercase letters, numbers and hyphens. Filled in from the name until you change it.', 'ছোট হাতের ইংরেজি অক্ষর, সংখ্যা ও হাইফেন। আপনি না বদলানো পর্যন্ত নাম থেকে নিজে ভরে যায়।'],
  'pe.short': ['Short description', 'সংক্ষিপ্ত বিবরণ'],
  'pe.shortHint': ['One or two sentences shown on product cards and in search results.', 'এক-দুই বাক্য; প্রোডাক্ট কার্ড ও সার্চ ফলাফলে দেখায়।'],
  'pe.desc': ['Description', 'বিবরণ'],
  'pe.descHint': ['Markdown works: **bold**, "- " for lists, "## " for headings.', 'মার্কডাউন চলবে: **গাঢ়**, তালিকার জন্য "- ", শিরোনামের জন্য "## "।'],
  'pe.write': ['Write', 'লিখুন'],
  'pe.preview': ['Preview', 'প্রিভিউ'],
  'pe.previewEmpty': ['Nothing to preview yet.', 'প্রিভিউ করার মতো কিছু এখনো নেই।'],
  /* organisation */
  'pe.org': ['Organisation', 'সাজানো'],
  'pe.status': ['Status', 'অবস্থা'],
  'pe.statusHint': ['Only published products are visible in the store.', 'শুধু প্রকাশিত প্রোডাক্ট স্টোরে দেখা যায়।'],
  'pe.category': ['Category', 'ক্যাটাগরি'],
  'pe.noCategory': ['No category', 'ক্যাটাগরি নেই'],
  'pe.brand': ['Brand', 'ব্র্যান্ড'],
  'pe.noBrand': ['No brand', 'ব্র্যান্ড নেই'],
  'pe.featured': ['Show among featured products', 'ফিচার্ড প্রোডাক্টের মধ্যে দেখান'],
  'pe.type': ['Product type', 'প্রোডাক্টের ধরন'],
  'pe.type.simple': ['Simple — one price, one stock count', 'সাধারণ — একটি দাম, একটি স্টক'],
  'pe.type.variable': ['With variants — sizes, colours …', 'ভ্যারিয়েন্টসহ — সাইজ, রং ইত্যাদি'],
  'pe.typeFixed': ['The type cannot be changed after the product is created.', 'প্রোডাক্ট তৈরির পরে ধরন বদলানো যায় না।'],
  /* images */
  'pe.images': ['Images', 'ছবি'],
  'pe.imagesHelp': ['The first image is the cover. JPEG, PNG or WebP up to 5 MB each; large photos are resized for you.', 'প্রথম ছবিটি কভার। JPEG, PNG বা WebP, প্রতিটি সর্বোচ্চ ৫ MB; বড় ছবি নিজে থেকে ছোট করা হয়।'],
  'pe.imgAdd': ['Upload images', 'ছবি আপলোড করুন'],
  'pe.imgAlt': ['Describe the image', 'ছবির বর্ণনা'],
  'pe.imgAltFor': ['Description of image {n}', '{n} নম্বর ছবির বর্ণনা'],
  'pe.imgCover': ['Cover', 'কভার'],
  'pe.imgMakeCover': ['Make cover', 'কভার করুন'],
  'pe.imgLeft': ['Move earlier', 'আগে নিন'],
  'pe.imgRight': ['Move later', 'পরে নিন'],
  'pe.imgRemove': ['Remove image', 'ছবি সরান'],
  'pe.imgUploading': ['Uploading {n} image(s)…', '{n}টি ছবি আপলোড হচ্ছে…'],
  'pe.imgLimit': ['A product can have at most {n} images.', 'একটি প্রোডাক্টে সর্বোচ্চ {n}টি ছবি থাকতে পারে।'],
  'pe.imgNone': ['No images yet — products with a photo sell better.', 'এখনো কোনো ছবি নেই — ছবি থাকলে বিক্রি ভালো হয়।'],
  'pe.imgFailed': ['An image could not be uploaded: {why}', 'একটি ছবি আপলোড করা যায়নি: {why}'],
  /* pricing */
  'pe.pricing': ['Pricing', 'দাম'],
  'pe.price': ['Price (৳)', 'দাম (৳)'],
  'pe.salePrice': ['Sale price (৳)', 'ছাড়ের দাম (৳)'],
  'pe.salePriceHint': ['Leave empty when there is no sale. Must be lower than the price.', 'ছাড় না থাকলে খালি রাখুন। দামের চেয়ে কম হতে হবে।'],
  'pe.saleStart': ['Sale starts', 'ছাড় শুরু'],
  'pe.saleEnd': ['Sale ends', 'ছাড় শেষ'],
  'pe.saleDates': ['Empty dates: the sale runs until you remove the sale price. Times are Bangladesh time.', 'তারিখ খালি থাকলে ছাড়ের দাম না সরানো পর্যন্ত ছাড় চলবে। সময় বাংলাদেশ সময়।'],
  'pe.pricingVariable': ['Every variant has its own price below. The sale dates apply to all variants.', 'প্রতিটি ভ্যারিয়েন্টের নিজস্ব দাম নিচে দেওয়া আছে। ছাড়ের তারিখ সব ভ্যারিয়েন্টে প্রযোজ্য।'],
  /* inventory */
  'pe.inventory': ['Inventory', 'ইনভেন্টরি'],
  'pe.sku': ['SKU', 'এসকেইউ (SKU)'],
  'pe.skuHint': ['Your own product code. Must be unique. Letters, numbers, dot, hyphen, underscore.', 'আপনার নিজস্ব প্রোডাক্ট কোড। ইউনিক হতে হবে। অক্ষর, সংখ্যা, ডট, হাইফেন, আন্ডারস্কোর।'],
  'pe.track': ['Track stock', 'স্টক ট্র্যাক করুন'],
  'pe.trackHint': ['Off: always available, no limit. On: the store stops selling at zero. Changing this later does not change the stock count.', 'বন্ধ: সবসময় পাওয়া যাবে, কোনো সীমা নেই। চালু: স্টক শূন্য হলে স্টোর বিক্রি বন্ধ করবে। পরে বদলালে স্টকের সংখ্যা বদলায় না।'],
  'pe.stock': ['Starting stock', 'শুরুর স্টক'],
  'pe.stockCurrent': ['Current stock', 'বর্তমান স্টক'],
  'pe.stockReserved': ['{n} held by open orders', '{n}টি খোলা অর্ডারে আটকে আছে'],
  'pe.stockAdjust': ['To change it, use the Inventory page — every change is logged there.', 'বদলাতে ইনভেন্টরি পেজ ব্যবহার করুন — সেখানে প্রতিটি পরিবর্তন লগ হয়।'],
  'pe.stockGo': ['Open Inventory', 'ইনভেন্টরি খুলুন'],
  'pe.backorder': ['Keep selling when stock runs out (backorder)', 'স্টক শেষ হলেও বিক্রি চালু রাখুন (ব্যাকঅর্ডার)'],
  'pe.maxPerOrder': ['Maximum per order', 'প্রতি অর্ডারে সর্বোচ্চ'],
  'pe.low': ['Low-stock alert at', 'স্টক কমের সতর্কতা'],
  'pe.lowHint': ['Leave empty to use the store default.', 'খালি রাখলে স্টোরের ডিফল্ট ব্যবহার হবে।'],
  /* variants */
  'pe.variants': ['Variants', 'ভ্যারিয়েন্ট'],
  'pe.optTitle': ['Options', 'অপশন'],
  'pe.optHelp': ['Up to 3 options, for example Size: S, M, L. Separate the values with commas — the combinations are created for you.', 'সর্বোচ্চ ৩টি অপশন, যেমন সাইজ: S, M, L। মানগুলো কমা দিয়ে আলাদা করুন — কম্বিনেশন নিজে থেকে তৈরি হবে।'],
  'pe.optName': ['Option name', 'অপশনের নাম'],
  'pe.optValues': ['Values (comma separated)', 'মান (কমা দিয়ে আলাদা)'],
  'pe.optAdd': ['Add option', 'অপশন যোগ করুন'],
  'pe.optRemove': ['Remove option', 'অপশন সরান'],
  'pe.varTitle': ['Variants', 'ভ্যারিয়েন্ট'],
  'pe.varHelp': ['Each combination is sold on its own and has its own stock. A variant that exists cannot be deleted (old orders refer to it) — switch it off instead.', 'প্রতিটি কম্বিনেশন আলাদাভাবে বিক্রি হয় এবং তার নিজস্ব স্টক আছে। যে ভ্যারিয়েন্ট একবার তৈরি হয়েছে তা মোছা যায় না (পুরনো অর্ডারে তার উল্লেখ আছে) — বরং বন্ধ করে দিন।'],
  'pe.varNone': ['Add an option with its values to create variants.', 'ভ্যারিয়েন্ট তৈরি করতে একটি অপশন ও তার মান যোগ করুন।'],
  'pe.varCount': ['{n} of {max} variants', '{max}টির মধ্যে {n}টি ভ্যারিয়েন্ট'],
  'pe.varNew': ['New', 'নতুন'],
  'pe.varObsolete': ['No longer offered — switched off', 'আর দেওয়া হয় না — বন্ধ করা হয়েছে'],
  'pe.varLimit': ['A product can have at most {n} variants.', 'একটি প্রোডাক্টে সর্বোচ্চ {n}টি ভ্যারিয়েন্ট থাকতে পারে।'],
  'pe.vcol.variant': ['Variant', 'ভ্যারিয়েন্ট'],
  'pe.vcol.sku': ['SKU', 'SKU'],
  'pe.vcol.price': ['Price (৳)', 'দাম (৳)'],
  'pe.vcol.sale': ['Sale (৳)', 'ছাড় (৳)'],
  'pe.vcol.stock': ['Stock', 'স্টক'],
  'pe.vcol.active': ['Sold', 'বিক্রি হয়'],
  'pe.vRemove': ['Remove this unsaved variant', 'এই অসংরক্ষিত ভ্যারিয়েন্ট সরান'],
  'pe.vField': ['{field} of {variant}', '{variant}-এর {field}'],
  /* details */
  'pe.details': ['Details', 'বিস্তারিত'],
  'pe.highlights': ['Highlights (one per line)', 'মূল বৈশিষ্ট্য (প্রতি লাইনে একটি)'],
  'pe.specs': ['Specifications', 'স্পেসিফিকেশন'],
  'pe.specLabel': ['Name', 'নাম'],
  'pe.specValue': ['Value', 'মান'],
  'pe.specAdd': ['Add row', 'সারি যোগ করুন'],
  'pe.specRemove': ['Remove row', 'সারি সরান'],
  'pe.tags': ['Tags (comma separated)', 'ট্যাগ (কমা দিয়ে আলাদা)'],
  'pe.tagsHint': ['Tags help customers find the product in search.', 'ট্যাগ থাকলে সার্চে প্রোডাক্ট খুঁজে পাওয়া সহজ হয়।'],
  /* seo + private */
  'pe.seo': ['Search engines', 'সার্চ ইঞ্জিন'],
  'pe.seoTitle': ['Page title', 'পেজের শিরোনাম'],
  'pe.seoTitleHint': ['Up to 70 characters. Empty: the product name is used.', 'সর্বোচ্চ ৭০ অক্ষর। খালি থাকলে প্রোডাক্টের নাম ব্যবহার হবে।'],
  'pe.seoDesc': ['Page description', 'পেজের বিবরণ'],
  'pe.seoDescHint': ['Up to 160 characters. Empty: the short description is used.', 'সর্বোচ্চ ১৬০ অক্ষর। খালি থাকলে সংক্ষিপ্ত বিবরণ ব্যবহার হবে।'],
  'pe.private': ['Private — staff only', 'ব্যক্তিগত — শুধু স্টাফ'],
  'pe.privateHelp': ['Never shown to customers.', 'কাস্টমারকে কখনো দেখানো হয় না।'],
  'pe.cost': ['Cost price (৳)', 'ক্রয়মূল্য (৳)'],
  'pe.supplier': ['Supplier', 'সরবরাহকারী'],
  'pe.notes': ['Notes', 'নোট'],
  /* bar + messages */
  'pe.create': ['Create product', 'প্রোডাক্ট তৈরি করুন'],
  'pe.save': ['Save changes', 'পরিবর্তন সংরক্ষণ'],
  'pe.cancel': ['Cancel', 'বাতিল'],
  'pe.created': ['Product created.', 'প্রোডাক্ট তৈরি হয়েছে।'],
  'pe.saved': ['Product saved.', 'প্রোডাক্ট সংরক্ষিত হয়েছে।'],
  'pe.unsaved': ['Unsaved changes', 'অসংরক্ষিত পরিবর্তন'],
  'pe.discardTitle': ['Leave without saving?', 'সংরক্ষণ না করেই বেরিয়ে যাবেন?'],
  'pe.discardText': ['Your changes to this product will be lost.', 'এই প্রোডাক্টে আপনার করা পরিবর্তন হারিয়ে যাবে।'],
  'pe.discard': ['Leave', 'বেরিয়ে যান'],
  'pe.fixErrors': ['Some fields need attention — they are marked below.', 'কিছু ঘর ঠিক করা দরকার — নিচে চিহ্নিত আছে।'],
  /* error codes from shared/productFlow.js */
  'pe.err.required': ['This field is required', 'এই ঘরটি পূরণ করা আবশ্যক'],
  'pe.err.bad_slug': ['Use lowercase letters, numbers and hyphens only', 'শুধু ছোট হাতের ইংরেজি অক্ষর, সংখ্যা ও হাইফেন ব্যবহার করুন'],
  'pe.err.slug_taken': ['Another product already uses this address', 'এই ঠিকানা অন্য একটি প্রোডাক্ট ব্যবহার করছে'],
  'pe.err.bad_price': ['Enter a whole number of taka, at least 1', 'টাকার একটি পূর্ণসংখ্যা দিন, কমপক্ষে ১'],
  'pe.err.bad_sale': ['The sale price must be a whole number below the price', 'ছাড়ের দাম দামের চেয়ে কম একটি পূর্ণসংখ্যা হতে হবে'],
  'pe.err.sale_dates': ['The sale must end after it starts', 'ছাড় শুরুর পরে শেষ হতে হবে'],
  'pe.err.bad_sku': ['Use letters, numbers, dot, hyphen or underscore (max 40)', 'অক্ষর, সংখ্যা, ডট, হাইফেন বা আন্ডারস্কোর ব্যবহার করুন (সর্বোচ্চ ৪০)'],
  'pe.err.sku_taken': ['Another product already uses this SKU', 'এই SKU অন্য একটি প্রোডাক্ট ব্যবহার করছে'],
  'pe.err.dup_sku': ['The same SKU is used twice in this product', 'এই প্রোডাক্টেই একই SKU দুইবার আছে'],
  'pe.err.bad_number': ['Enter a whole number, 0 or more', 'একটি পূর্ণসংখ্যা দিন, ০ বা তার বেশি'],
  'pe.err.bad_max_per_order': ['Enter a whole number from 1 to 50', '১ থেকে ৫০-এর মধ্যে একটি পূর্ণসংখ্যা দিন'],
  'pe.err.bad_value': ['This value is not valid', 'এই মানটি সঠিক নয়'],
  'pe.err.no_options': ['Add at least one option with values', 'কমপক্ষে একটি অপশন ও তার মান যোগ করুন'],
  'pe.err.too_many': ['Too many options or variants', 'অপশন বা ভ্যারিয়েন্ট অনেক বেশি'],
  'pe.err.option_incomplete': ['Every option needs a name and at least one value', 'প্রতিটি অপশনের নাম ও কমপক্ষে একটি মান লাগবে'],
  'pe.err.option_dup': ['Two options have the same name', 'দুটি অপশনের নাম একই'],
  'pe.err.too_many_values': ['An option can have at most 12 values', 'একটি অপশনে সর্বোচ্চ ১২টি মান থাকতে পারে'],
  'pe.err.no_variants': ['Keep at least one variant switched on', 'কমপক্ষে একটি ভ্যারিয়েন্ট চালু রাখুন'],
  'pe.err.variant_incomplete': ['This combination does not match the options', 'এই কম্বিনেশন অপশনগুলোর সঙ্গে মেলে না'],
  'pe.err.dup_combo': ['This combination exists twice', 'এই কম্বিনেশন দুইবার আছে'],
});

const STATUS_IDS = Object.keys(PRODUCT_STATUS);
const toLocalInput = (ms) => (ms ? toDhakaInput(ms) : '');
const msOf = (v) => toMillis(v) || null;
const comboLabel = (v) => Object.values(v.optionValues || {}).join(' / ') || '—';
const errMsg = (code) => t(`pe.err.${code}`, null, t('pe.err.bad_value'));

const blank = () => ({
  name: '', slug: '', slugTouched: false, status: 'draft', type: 'simple', categoryId: '', brandId: '', sku: '',
  price: '', salePrice: '', saleStart: null, saleEnd: null, shortDescription: '', description: '', highlights: [], specs: [], tags: [],
  images: [], icon: '', featured: false, seoTitle: '', seoDescription: '', track: true, allowBackorder: false, maxPerOrder: 10, lowStockThreshold: '',
  stock: 0, reserved: 0, hasInv: false, options: [], variants: [], cost: { costPrice: '', supplier: '', notes: '' }, removed: [],
});

/** Editor state from stored documents. `duplicate`: a copy for a new product (no images, SKUs, stock; draft). */
function stateFrom(id, ex, { duplicate = false } = {}) {
  const p = ex.product;
  const inv = ex.inv || {};
  const own = inv[id];
  const first = p.type === 'variable' ? Object.values(inv)[0] : own;
  const s = blank();
  Object.assign(s, {
    name: duplicate ? `${p.name} (copy)` : p.name, slug: duplicate ? '' : (p.slug || ''), slugTouched: !duplicate,
    status: duplicate ? 'draft' : (p.status || 'draft'), type: p.type === 'variable' ? 'variable' : 'simple',
    categoryId: p.categoryId || '', brandId: p.brandId || '', sku: duplicate ? '' : (p.sku || ''),
    price: own ? own.price : (p.price ?? ''), salePrice: own ? (own.salePrice ?? '') : (p.salePrice ?? ''),
    saleStart: msOf(first ? first.saleStart : p.saleStart), saleEnd: msOf(first ? first.saleEnd : p.saleEnd),
    shortDescription: p.shortDescription || '', description: p.description || '',
    highlights: [...(p.highlights || [])], specs: (p.specs || []).map((x) => ({ ...x })), tags: [...(p.tags || [])],
    images: duplicate ? [] : (p.images || []).map((x) => ({ ...x })), icon: p.icon || '', featured: p.featured === true,
    seoTitle: p.seoTitle || '', seoDescription: p.seoDescription || '',
    track: first ? first.track === true : true, allowBackorder: first ? first.allowBackorder === true : false,
    maxPerOrder: first && Number.isFinite(first.maxPerOrder) ? first.maxPerOrder : 10,
    lowStockThreshold: first && Number.isFinite(first.lowStockThreshold) ? first.lowStockThreshold : '',
    stock: duplicate ? 0 : (own ? own.stock || 0 : 0), reserved: own && !duplicate ? own.reserved || 0 : 0, hasInv: !!own && !duplicate,
    options: (p.options || []).map((o) => ({ name: o.name, values: [...(o.values || [])] })),
    variants: (p.variants || []).map((v) => {
      const i = inv[lineKey(id, v.id)];
      return {
        id: v.id, optionValues: { ...(v.optionValues || {}) }, sku: duplicate ? '' : (v.sku || ''), image: v.image || '',
        price: i ? i.price : '', salePrice: i ? (i.salePrice ?? '') : '', stock: duplicate ? 0 : (i ? i.stock || 0 : 0), reserved: i && !duplicate ? i.reserved || 0 : 0,
        active: v.active !== false, existing: !!i && !duplicate,
      };
    }),
  });
  if (ex.cost) s.cost = { costPrice: ex.cost.costPrice ?? '', supplier: ex.cost.supplier || '', notes: ex.cost.notes || '' };
  return s;
}

const cartesian = (lists) => lists.reduce((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);

export default {
  async mount(ctx) {
    const creating = !ctx.params.id;
    if (!needs(ctx, creating ? 'products.write' : 'products.read')) return;
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      const canWrite = can('products.write');
      const canCost = can('costs.read');
      const cat = await loadAdminCatalog();
      const backLink = html`<a class="back-link" href="${href('/products')}">${icon('arrow-left', { size: 16 })}<span>${t('pe.back')}</span></a>`;

      let ex = null;
      let id;
      let S;
      if (creating) {
        id = newProductId();
        const from = ctx.query.from ? await loadProductForEdit(String(ctx.query.from)) : null;
        S = from && !isLegacyProduct(from.product) ? stateFrom(id, from, { duplicate: true }) : blank();
      } else {
        id = decodeURIComponent(String(ctx.params.id));
        ex = await loadProductForEdit(id);
        if (ctx.signal.aborted) return;
        if (!ex) { render(ctx.el, html`${backLink}${emptyState({ icon: 'package', title: t('pe.notFound'), text: t('pe.notFoundText') })}`); return; }
        if (isLegacyProduct(ex.product)) {
          render(ctx.el, html`${backLink}${emptyState({ icon: 'alert-triangle', title: t('pe.legacyTitle'), text: t('pe.legacyText'), action: can('migrate.run') ? { label: t('pe.legacyGo'), href: href('/setup') } : null })}`);
          return;
        }
        S = stateFrom(id, ex);
      }
      if (ctx.signal.aborted) return;
      let dirty = false;
      let uploading = 0;

      const catPath = (c) => { const names = []; let cur = c; let guard = 0; while (cur && guard++ < 6) { names.unshift(cur.name); cur = cur.parentId ? cat.catById[cur.parentId] : null; } return names.join(' › '); };
      const opt = (value, label, cur) => html`<option value="${value}" ${String(value) === String(cur) ? raw('selected') : ''}>${label}</option>`;
      const panel = (key, title, body, help = '') => html`<section class="panel pe-panel" aria-labelledby="pe-${key}-h"><div class="panel-head"><h2 id="pe-${key}-h">${title}</h2></div><div class="panel-body stack">${help ? html`<p class="muted small">${help}</p>` : ''}${body}</div></section>`;

      /* ── dynamic hosts (their inputs write straight into S, so each can be repainted on its own) ── */
      const imagesHtml = () => html`
        ${S.images.length ? html`<ul class="pe-images">${S.images.map((im, i) => html`<li class="pe-img">
          <img src="${safeUrl(im.thumb || im.url)}" alt="${im.alt || ''}" width="160" height="160" loading="lazy">
          ${i === 0 ? html`<span class="pe-cover">${badge(t('pe.imgCover'), 'brand')}</span>` : ''}
          <input class="input" data-input="imgAlt" data-i="${i}" value="${im.alt || ''}" maxlength="${PRODUCT_LIMITS.alt}" placeholder="${t('pe.imgAlt')}" aria-label="${t('pe.imgAltFor', { n: num(i + 1) })}">
          ${canWrite ? html`<div class="row">
            ${i > 0 ? html`<button type="button" class="btn btn-sm btn-icon" data-action="imgCover" data-i="${i}" title="${t('pe.imgMakeCover')}" aria-label="${t('pe.imgMakeCover')}">${icon('star', { size: 16 })}</button>` : ''}
            ${i > 0 ? html`<button type="button" class="btn btn-sm btn-icon" data-action="imgMove" data-i="${i}" data-d="-1" title="${t('pe.imgLeft')}" aria-label="${t('pe.imgLeft')}">${icon('arrow-left', { size: 16 })}</button>` : ''}
            ${i < S.images.length - 1 ? html`<button type="button" class="btn btn-sm btn-icon" data-action="imgMove" data-i="${i}" data-d="1" title="${t('pe.imgRight')}" aria-label="${t('pe.imgRight')}">${icon('arrow-right', { size: 16 })}</button>` : ''}
            <button type="button" class="btn btn-sm btn-icon btn-danger-ghost" data-action="imgRemove" data-i="${i}" title="${t('pe.imgRemove')}" aria-label="${t('pe.imgRemove')}">${icon('trash', { size: 16 })}</button>
          </div>` : ''}</li>`)}</ul>` : html`<p class="muted">${t('pe.imgNone')}</p>`}
        ${canWrite ? html`<div class="row row-wrap"><button type="button" class="btn" data-action="imgAdd" ${uploading || S.images.length >= LIMITS.MAX_IMAGES ? raw('disabled') : ''}>${icon('upload', { size: 16 })}<span>${t('pe.imgAdd')}</span></button>
          <span class="muted small" role="status">${uploading ? t('pe.imgUploading', { n: num(uploading) }) : ''}</span></div>` : ''}`;

      const specsHtml = () => html`
        ${S.specs.map((s, i) => html`<div class="pe-spec">
          <input class="input" data-input="spec" data-i="${i}" data-k="label" value="${s.label}" maxlength="${PRODUCT_LIMITS.specLabel}" placeholder="${t('pe.specLabel')}" aria-label="${t('pe.specLabel')} ${num(i + 1)}">
          <input class="input" data-input="spec" data-i="${i}" data-k="value" value="${s.value}" maxlength="${PRODUCT_LIMITS.specValue}" placeholder="${t('pe.specValue')}" aria-label="${t('pe.specValue')} ${num(i + 1)}">
          ${canWrite ? html`<button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="specRemove" data-i="${i}" title="${t('pe.specRemove')}" aria-label="${t('pe.specRemove')}">${icon('x', { size: 16 })}</button>` : ''}
        </div>`)}
        ${canWrite && S.specs.length < PRODUCT_LIMITS.specs ? html`<div><button type="button" class="btn btn-sm" data-action="specAdd">${icon('plus', { size: 16 })}<span>${t('pe.specAdd')}</span></button></div>` : ''}`;

      const variantRow = (v, i) => {
        const obsolete = !cartesianKeys().has(JSON.stringify(S.options.map((o) => v.optionValues[o.name])));
        const cell = (k, type = 'text', extra = {}) => html`<input class="input" type="${type}" data-input="v" data-i="${i}" data-k="${k}" value="${v[k] ?? ''}" ${extra.min !== undefined ? raw(`min="${extra.min}"`) : ''} ${type === 'number' ? raw('step="1" inputmode="numeric"') : raw('maxlength="40"')} aria-label="${t('pe.vField', { field: extra.label, variant: comboLabel(v) })}">`;
        return html`<tr>
          <td class="cell-first"><div class="strong">${comboLabel(v)}</div>${!v.existing ? html`<span class="cell-sub">${badge(t('pe.varNew'), 'info')}</span>` : ''}${v.existing && obsolete ? html`<span class="cell-sub">${badge(t('pe.varObsolete'), 'warn')}</span>` : ''}</td>
          <td data-label="${t('pe.vcol.sku')}">${cell('sku', 'text', { label: t('pe.vcol.sku') })}</td>
          <td data-label="${t('pe.vcol.price')}" class="num">${cell('price', 'number', { min: 1, label: t('pe.vcol.price') })}</td>
          <td data-label="${t('pe.vcol.sale')}" class="num">${cell('salePrice', 'number', { min: 1, label: t('pe.vcol.sale') })}</td>
          <td data-label="${t('pe.vcol.stock')}" class="num">${v.existing ? html`<span class="strong">${num(v.stock)}</span>${v.reserved ? html`<span class="cell-sub">${t('pe.stockReserved', { n: num(v.reserved) })}</span>` : ''}` : (S.track ? cell('stock', 'number', { min: 0, label: t('pe.vcol.stock') }) : html`<span class="muted">—</span>`)}</td>
          <td data-label="${t('pe.vcol.active')}"><input type="checkbox" data-change="vActive" data-i="${i}" ${v.active ? raw('checked') : ''} aria-label="${t('pe.vField', { field: t('pe.vcol.active'), variant: comboLabel(v) })}"></td>
          <td class="col-actions">${!v.existing && canWrite ? html`<button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="vRemove" data-i="${i}" title="${t('pe.vRemove')}" aria-label="${t('pe.vRemove')}">${icon('x', { size: 16 })}</button>` : ''}</td>
        </tr>`;
      };
      const cartesianKeys = () => new Set(cartesian(S.options.filter((o) => o.name && o.values.length).map((o) => o.values)).map((c) => JSON.stringify(c)));

      const variantsHtml = () => html`
        <h3 class="pe-h3">${t('pe.optTitle')}</h3>
        <p class="muted small">${t('pe.optHelp')}</p>
        ${S.options.map((o, i) => html`<div class="pe-opt">
          <div class="field"><label for="opt-name-${i}">${t('pe.optName')}</label><input class="input" id="opt-name-${i}" data-change="optName" data-i="${i}" value="${o.name}" maxlength="${PRODUCT_LIMITS.optionName}"></div>
          <div class="field"><label for="opt-values-${i}">${t('pe.optValues')}</label><input class="input" id="opt-values-${i}" data-change="optValues" data-i="${i}" value="${o.values.join(', ')}"></div>
          ${canWrite ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="optRemove" data-i="${i}">${icon('x', { size: 16 })}<span>${t('pe.optRemove')}</span></button>` : ''}
        </div>`)}
        ${canWrite && S.options.length < LIMITS.MAX_OPTIONS ? html`<div><button type="button" class="btn btn-sm" data-action="optAdd">${icon('plus', { size: 16 })}<span>${t('pe.optAdd')}</span></button></div>` : ''}
        <h3 class="pe-h3">${t('pe.varTitle')} <span class="muted small">${t('pe.varCount', { n: num(S.variants.length), max: num(LIMITS.MAX_VARIANTS) })}</span></h3>
        <p class="muted small">${t('pe.varHelp')}</p>
        <div id="pe-variants-err" aria-live="polite"></div>
        ${S.variants.length ? html`<div class="table-wrap"><table class="table table-stack table-cards pe-vtable">
          <thead><tr><th scope="col">${t('pe.vcol.variant')}</th><th scope="col">${t('pe.vcol.sku')}</th><th scope="col" class="num">${t('pe.vcol.price')}</th><th scope="col" class="num">${t('pe.vcol.sale')}</th><th scope="col" class="num">${t('pe.vcol.stock')}</th><th scope="col">${t('pe.vcol.active')}</th><th scope="col" class="col-actions"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
          <tbody>${S.variants.map(variantRow)}</tbody></table></div>` : html`<p class="muted">${t('pe.varNone')}</p>`}`;

      /* ── the form ── */
      const formHtml = () => {
        const variable = S.type === 'variable';
        return html`<form id="pe-form" data-form="product" novalidate>
          <fieldset class="pe-fields" ${canWrite ? '' : raw('disabled')}>
          <div class="stack">
            ${canWrite ? '' : html`<p class="alert">${icon('info', { size: 18 })}<span>${t('pe.readonly')}</span></p>`}
            ${panel('basics', t('pe.basics'), html`
              ${fieldHtml({ name: 'name', label: t('pe.name'), value: S.name, required: true, attrs: { maxlength: PRODUCT_LIMITS.name, 'data-input': 'name' } })}
              ${fieldHtml({ name: 'slug', label: t('pe.slug'), value: S.slug, hint: t('pe.slugHint'), attrs: { maxlength: PRODUCT_LIMITS.slug, 'data-input': 'slug', autocapitalize: 'off', spellcheck: 'false' } })}
              ${fieldHtml({ name: 'shortDescription', label: t('pe.short'), type: 'textarea', rows: 2, value: S.shortDescription, hint: t('pe.shortHint'), attrs: { maxlength: PRODUCT_LIMITS.shortDescription } })}
              <div class="field">
                <div class="row row-between"><label class="label" for="f-description">${t('pe.desc')}</label>
                  <div class="seg" role="group" aria-label="${t('pe.desc')}"><button type="button" class="seg-btn" data-action="mdWrite" aria-pressed="true">${t('pe.write')}</button><button type="button" class="seg-btn" data-action="mdPreview" aria-pressed="false">${t('pe.preview')}</button></div></div>
                <textarea class="textarea" id="f-description" name="description" rows="9" maxlength="${PRODUCT_LIMITS.description}" aria-describedby="hint-description err-description">${S.description}</textarea>
                <div class="pe-preview prose" id="pe-preview" hidden></div>
                <div class="field-hint" id="hint-description">${t('pe.descHint')}</div><div class="field-error" id="err-description" aria-live="polite"></div>
              </div>`)}
            ${panel('org', t('pe.org'), html`
              <div class="pe-grid">
                ${fieldHtml({ name: 'status', label: t('pe.status'), type: 'select', value: S.status, options: STATUS_IDS.map((k) => ({ value: k, label: lbl(PRODUCT_STATUS[k]) })), hint: t('pe.statusHint') })}
                ${creating
                  ? fieldHtml({ name: 'type', label: t('pe.type'), type: 'select', value: S.type, options: [{ value: 'simple', label: t('pe.type.simple') }, { value: 'variable', label: t('pe.type.variable') }], attrs: { 'data-change': 'type' } })
                  : html`<div class="field"><span class="label">${t('pe.type')}</span><div class="strong">${t(`pe.type.${S.type}`)}</div><div class="field-hint">${t('pe.typeFixed')}</div></div>`}
                ${fieldHtml({ name: 'categoryId', label: t('pe.category'), type: 'select', value: S.categoryId, options: [{ value: '', label: t('pe.noCategory') }, ...cat.categories.map((c) => ({ value: c.id, label: catPath(c) }))] })}
                ${fieldHtml({ name: 'brandId', label: t('pe.brand'), type: 'select', value: S.brandId, options: [{ value: '', label: t('pe.noBrand') }, ...cat.brands.map((b) => ({ value: b.id, label: b.name }))] })}
              </div>
              ${fieldHtml({ name: 'featured', label: t('pe.featured'), type: 'switch', value: S.featured })}`)}
            ${panel('images', t('pe.images'), html`<div id="pe-images" class="stack"></div>`, t('pe.imagesHelp'))}
            ${panel('pricing', t('pe.pricing'), html`
              <div class="pe-grid">
                ${variable ? '' : html`${fieldHtml({ name: 'price', label: t('pe.price'), type: 'number', value: S.price, required: true, prefix: '৳', attrs: { min: 1, step: 1, inputmode: 'numeric' } })}
                  ${fieldHtml({ name: 'salePrice', label: t('pe.salePrice'), type: 'number', value: S.salePrice, prefix: '৳', hint: t('pe.salePriceHint'), attrs: { min: 1, step: 1, inputmode: 'numeric' } })}`}
                ${fieldHtml({ name: 'saleStart', label: t('pe.saleStart'), type: 'datetime-local', value: toLocalInput(S.saleStart) })}
                ${fieldHtml({ name: 'saleEnd', label: t('pe.saleEnd'), type: 'datetime-local', value: toLocalInput(S.saleEnd) })}
              </div>`, variable ? `${t('pe.pricingVariable')} ${t('pe.saleDates')}` : t('pe.saleDates'))}
            ${panel('inventory', t('pe.inventory'), html`
              <div class="pe-grid pe-grid-3">
                ${variable ? '' : fieldHtml({ name: 'sku', label: t('pe.sku'), value: S.sku, hint: t('pe.skuHint'), attrs: { maxlength: 40, autocapitalize: 'characters', spellcheck: 'false' } })}
                ${fieldHtml({ name: 'maxPerOrder', label: t('pe.maxPerOrder'), type: 'number', value: S.maxPerOrder, attrs: { min: 1, max: LIMITS.MAX_QTY_PER_LINE, step: 1, inputmode: 'numeric' } })}
                ${fieldHtml({ name: 'lowStockThreshold', label: t('pe.low'), type: 'number', value: S.lowStockThreshold, hint: t('pe.lowHint'), attrs: { min: 0, step: 1, inputmode: 'numeric' } })}
              </div>
              ${fieldHtml({ name: 'track', label: t('pe.track'), type: 'switch', value: S.track, hint: t('pe.trackHint') })}
              ${fieldHtml({ name: 'allowBackorder', label: t('pe.backorder'), type: 'switch', value: S.allowBackorder })}
              ${variable ? '' : (S.hasInv
                ? html`<div class="field"><span class="label">${t('pe.stockCurrent')}</span><div class="strong">${num(S.stock)}${S.reserved ? html` <span class="muted small">· ${t('pe.stockReserved', { n: num(S.reserved) })}</span>` : ''}</div>
                    <div class="field-hint">${t('pe.stockAdjust')} ${can('inventory.read') ? html`<a href="${href('/inventory' + (S.sku ? `?q=${encodeURIComponent(S.sku)}` : ''))}">${t('pe.stockGo')}</a>` : ''}</div></div>`
                : (S.track ? fieldHtml({ name: 'stock', label: t('pe.stock'), type: 'number', value: S.stock, attrs: { min: 0, step: 1, inputmode: 'numeric' } }) : ''))}`)}
            ${variable ? panel('variants', t('pe.variants'), html`<div id="pe-variants" class="stack"></div>`) : ''}
            ${panel('details', t('pe.details'), html`
              ${fieldHtml({ name: 'highlights', label: t('pe.highlights'), type: 'textarea', rows: 4, value: S.highlights.join('\n') })}
              <div class="field"><span class="label" id="pe-specs-label">${t('pe.specs')}</span><div id="pe-specs" class="stack" role="group" aria-labelledby="pe-specs-label"></div></div>
              ${fieldHtml({ name: 'tags', label: t('pe.tags'), value: S.tags.join(', '), hint: t('pe.tagsHint') })}`)}
            ${panel('seo', t('pe.seo'), html`
              ${fieldHtml({ name: 'seoTitle', label: t('pe.seoTitle'), value: S.seoTitle, hint: t('pe.seoTitleHint'), attrs: { maxlength: PRODUCT_LIMITS.seoTitle } })}
              ${fieldHtml({ name: 'seoDescription', label: t('pe.seoDesc'), type: 'textarea', rows: 3, value: S.seoDescription, hint: t('pe.seoDescHint'), attrs: { maxlength: PRODUCT_LIMITS.seoDescription } })}`)}
            ${canCost ? panel('private', t('pe.private'), html`
              <div class="pe-grid">
                ${fieldHtml({ name: 'costPrice', label: t('pe.cost'), type: 'number', value: S.cost.costPrice, prefix: '৳', attrs: { min: 0, step: 1, inputmode: 'numeric' } })}
                ${fieldHtml({ name: 'supplier', label: t('pe.supplier'), value: S.cost.supplier, attrs: { maxlength: PRODUCT_LIMITS.supplier } })}
              </div>
              ${fieldHtml({ name: 'notes', label: t('pe.notes'), type: 'textarea', rows: 3, value: S.cost.notes, attrs: { maxlength: PRODUCT_LIMITS.notes } })}`, t('pe.privateHelp')) : ''}
          </div>
          </fieldset>
          ${canWrite ? html`<div class="sticky-bar pe-bar"><span class="muted small" id="pe-dirty" role="status"></span>
            <button type="button" class="btn" data-action="cancel">${t('pe.cancel')}</button>
            <button type="submit" class="btn btn-primary">${creating ? t('pe.create') : t('pe.save')}</button></div>` : ''}
        </form>`;
      };

      const header = () => html`${backLink}
        <div class="page-head"><div><h1>${creating ? t('pe.titleNew') : S.name || '—'}</h1>${creating ? '' : html`<p class="page-sub"><span class="mono">${id}</span></p>`}</div>
          <div class="page-actions">
            ${!creating && S.status === 'published' ? html`<a class="btn btn-sm" href="/product/${encodeURIComponent(S.slug)}" target="_blank" rel="noopener">${icon('external-link', { size: 16 })}<span>${t('pe.viewStore')}</span></a>` : ''}
            ${!creating && canWrite ? html`<a class="btn btn-sm" href="${href('/products/new?from=' + encodeURIComponent(id))}">${icon('copy', { size: 16 })}<span>${t('pe.duplicate')}</span></a>` : ''}
          </div></div>`;

      const $ = (sel) => ctx.el.querySelector(sel);
      const paintImages = () => { const h = $('#pe-images'); if (h) render(h, imagesHtml()); };
      const paintSpecs = () => { const h = $('#pe-specs'); if (h) render(h, specsHtml()); };
      const paintVariants = () => { const h = $('#pe-variants'); if (h) render(h, variantsHtml()); };
      const paintAll = () => {
        render($('#pe-page'), html`${header()}<div id="pe-form-host">${formHtml()}</div>`);
        paintImages(); paintSpecs(); paintVariants();
      };

      /* ── reading the static inputs back into S (type switch) and into the planner's raw form (save) ── */
      const collect = () => {
        const form = $('#pe-form');
        const v = form ? readForm(form) : {};
        const pickv = (k, fallback) => (v[k] !== undefined ? v[k] : fallback);
        return {
          ...S,
          name: pickv('name', S.name), slug: pickv('slug', S.slug), status: pickv('status', S.status), type: creating ? pickv('type', S.type) : S.type,
          categoryId: pickv('categoryId', S.categoryId), brandId: pickv('brandId', S.brandId), featured: pickv('featured', S.featured) === true,
          shortDescription: pickv('shortDescription', S.shortDescription), description: pickv('description', S.description),
          sku: pickv('sku', S.sku), price: pickv('price', S.price), salePrice: pickv('salePrice', S.salePrice),
          saleStart: v.saleStart !== undefined ? fromDhakaInput(v.saleStart) : S.saleStart, saleEnd: v.saleEnd !== undefined ? fromDhakaInput(v.saleEnd) : S.saleEnd,
          track: pickv('track', S.track) === true, allowBackorder: pickv('allowBackorder', S.allowBackorder) === true,
          maxPerOrder: pickv('maxPerOrder', S.maxPerOrder), lowStockThreshold: pickv('lowStockThreshold', S.lowStockThreshold),
          stock: S.hasInv ? S.stock : pickv('stock', S.stock),
          highlights: v.highlights !== undefined ? String(v.highlights).split('\n') : S.highlights,
          tags: v.tags !== undefined ? String(v.tags).split(',') : S.tags,
          seoTitle: pickv('seoTitle', S.seoTitle), seoDescription: pickv('seoDescription', S.seoDescription),
          cost: canCost ? { costPrice: pickv('costPrice', S.cost.costPrice), supplier: pickv('supplier', S.cost.supplier), notes: pickv('notes', S.cost.notes) } : undefined,
        };
      };

      /* ── options → variants ── */
      const regenerate = () => {
        const opts = S.options.filter((o) => o.name && o.values.length);
        const combos = opts.length ? cartesian(opts.map((o) => o.values.map((val) => [o.name, val]))).map((c) => Object.fromEntries(c)) : [];
        const same = (a, b) => opts.every((o) => a[o.name] === b[o.name]);
        const keyOf = (v) => JSON.stringify(opts.map((o) => v.optionValues[o.name]));
        const wanted = new Set(combos.map((c) => JSON.stringify(opts.map((o) => c[o.name]))));
        for (const v of S.variants) {
          const offered = wanted.has(keyOf(v));
          // a saved variant whose value was taken out of the options is switched off (it can never be deleted); typing the value back switches it on again
          if (!offered && v.existing && v.active) { v.active = false; v.autoOff = true; }
          else if (offered && v.autoOff) { v.active = true; v.autoOff = false; }
        }
        const basePrice = (S.variants.find((v) => v.price !== '' && v.price !== null) || {}).price ?? '';
        let capped = false;
        for (const c of combos) {
          if (S.variants.some((v) => same(v.optionValues, c))) continue;
          if (S.variants.length >= LIMITS.MAX_VARIANTS) { capped = true; break; }
          S.variants.push({ id: shortId(6), optionValues: c, sku: '', image: '', price: basePrice, salePrice: '', stock: 0, reserved: 0, active: true, existing: false });
        }
        // an unsaved variant that no combination matches any more is simply dropped
        S.variants = S.variants.filter((v) => v.existing || wanted.has(keyOf(v)));
        if (capped) toastError(t('pe.varLimit', { n: num(LIMITS.MAX_VARIANTS) }));
      };

      /* ── showing validation results ── */
      const showErrors = (errors = {}, variantErrors = {}) => {
        const form = $('#pe-form');
        const msgs = {};
        for (const [k, c] of Object.entries(errors)) if (k !== 'options' && k !== 'variants') msgs[k] = errMsg(c);
        showFormErrors(form, msgs);
        const lines = [];
        if (errors.options) lines.push(errMsg(errors.options));
        if (errors.variants) lines.push(errMsg(errors.variants));
        const fieldKey = { sku: 'sku', price: 'price', salePrice: 'sale', stock: 'stock', optionValues: 'variant', id: 'variant' };
        for (const [i, ve] of Object.entries(variantErrors)) {
          const v = S.variants[Number(i)];
          for (const [k, c] of Object.entries(ve)) {
            lines.push(`${comboLabel(v)} — ${t(`pe.vcol.${fieldKey[k] || 'variant'}`)}: ${errMsg(c)}`);
            const el = $(`#pe-variants [data-i="${i}"][data-k="${k}"]`);
            if (el) el.setAttribute('aria-invalid', 'true');
          }
        }
        const host = $('#pe-variants-err');
        if (host) render(host, lines.length ? html`<div class="alert alert-bad mb-3" role="alert">${icon('alert-triangle', { size: 18 })}<ul>${lines.map((l) => html`<li>${l}</li>`)}</ul></div>` : '');
        if (lines.length && !Object.keys(msgs).length && host) host.scrollIntoView({ block: 'center' });
      };

      /* ── mount ── */
      render(ctx.el, html`<div class="pe" id="pe-page"></div>`);
      paintAll();

      const markDirty = () => { if (!dirty) { dirty = true; const el = $('#pe-dirty'); if (el) el.textContent = t('pe.unsaved'); } };
      ctx.el.addEventListener('input', markDirty);
      ctx.el.addEventListener('change', markDirty);
      const guard = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
      window.addEventListener('beforeunload', guard);
      ctx.cleanup(() => { ctx.el.removeEventListener('input', markDirty); ctx.el.removeEventListener('change', markDirty); window.removeEventListener('beforeunload', guard); });

      const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };

      ctx.cleanup(bindActions(ctx.el, {
        cancel: async () => {
          if (dirty && !(await confirmDialog({ title: t('pe.discardTitle'), message: t('pe.discardText'), confirmText: t('pe.discard'), danger: true }))) return;
          dirty = false;
          ctx.router.navigate('/products');
        },
        mdWrite: () => { $('#f-description').hidden = false; $('#pe-preview').hidden = true; $('[data-action="mdWrite"]').setAttribute('aria-pressed', 'true'); $('[data-action="mdPreview"]').setAttribute('aria-pressed', 'false'); },
        mdPreview: () => {
          const src = $('#f-description').value;
          render($('#pe-preview'), src.trim() ? html`${raw(renderMarkdown(src))}` : html`<p class="muted">${t('pe.previewEmpty')}</p>`);
          $('#f-description').hidden = true; $('#pe-preview').hidden = false;
          $('[data-action="mdWrite"]').setAttribute('aria-pressed', 'false'); $('[data-action="mdPreview"]').setAttribute('aria-pressed', 'true');
        },
        imgAdd: async () => {
          const files = await pickFiles({ multiple: true });
          if (!files.length) return;
          const room = LIMITS.MAX_IMAGES - S.images.length;
          if (files.length > room) toastError(t('pe.imgLimit', { n: num(LIMITS.MAX_IMAGES) }));
          const batch = files.slice(0, Math.max(0, room));
          uploading = batch.length; paintImages();
          for (const file of batch) {
            try { S.images.push(await uploadProductImage(id, file)); markDirty(); }
            catch (e) { console.warn('image upload failed', e); toastError(t('pe.imgFailed', { why: explainError(e) })); }
            uploading -= 1; if (ctx.signal.aborted) return; paintImages();
          }
        },
        imgRemove: (el) => { const [gone] = S.images.splice(Number(el.dataset.i), 1); if (gone && gone.path) S.removed.push(gone); markDirty(); paintImages(); },
        imgMove: (el) => { move(S.images, Number(el.dataset.i), Number(el.dataset.d)); markDirty(); paintImages(); },
        imgCover: (el) => { const [im] = S.images.splice(Number(el.dataset.i), 1); S.images.unshift(im); markDirty(); paintImages(); },
        specAdd: () => { S.specs.push({ label: '', value: '' }); paintSpecs(); $$focusLast(); },
        specRemove: (el) => { S.specs.splice(Number(el.dataset.i), 1); markDirty(); paintSpecs(); },
        optAdd: () => { S.options.push({ name: '', values: [] }); paintVariants(); const last = $$all('#pe-variants [data-change="optName"]').pop(); if (last) last.focus(); },
        optRemove: (el) => { const [gone] = S.options.splice(Number(el.dataset.i), 1); for (const v of S.variants) delete v.optionValues[gone.name]; regenerate(); markDirty(); paintVariants(); },
        vRemove: (el) => { S.variants.splice(Number(el.dataset.i), 1); markDirty(); paintVariants(); },
      }, {
        change: {
          type: (el) => { S = collect(); S.type = el.value; paintAll(); },
          optName: (el) => {
            const o = S.options[Number(el.dataset.i)]; const next = el.value.trim();
            for (const v of S.variants) if (o.name in v.optionValues) { v.optionValues[next] = v.optionValues[o.name]; if (next !== o.name) delete v.optionValues[o.name]; }
            o.name = next; regenerate(); paintVariants();
          },
          optValues: (el) => {
            const o = S.options[Number(el.dataset.i)];
            o.values = [...new Set(el.value.split(',').map((x) => x.trim()).filter(Boolean))];
            regenerate(); paintVariants();
          },
          vActive: (el) => { const v = S.variants[Number(el.dataset.i)]; v.active = el.checked; v.autoOff = false; paintVariants(); },
        },
        input: {
          name: (el) => { if (!S.slugTouched && creating) { const slug = $('#f-slug'); if (slug) slug.value = slugify(el.value, { max: PRODUCT_LIMITS.slug }); } },
          slug: () => { S.slugTouched = true; },
          imgAlt: (el) => { S.images[Number(el.dataset.i)].alt = el.value; },
          spec: (el) => { S.specs[Number(el.dataset.i)][el.dataset.k] = el.value; },
          v: (el) => { S.variants[Number(el.dataset.i)][el.dataset.k] = el.value; el.removeAttribute('aria-invalid'); },
        },
        submit: {
          product: async (form) => {
            if (!canWrite) return;
            const btn = form.querySelector('[type="submit"]');
            await withBusy(btn, async () => {
              showFormErrors(form, {});
              const form0 = collect();
              const names = { category: (cat.catById[form0.categoryId] || {}).name || '', brand: (cat.brandById[form0.brandId] || {}).name || '' };
              try {
                await saveProduct({ mode: creating ? 'create' : 'update', id, form: form0, existing: creating ? null : { product: ex.product, inv: ex.inv }, names });
                dirty = false;
                for (const img of S.removed) deleteProductImage(img).catch(() => {});           // storage clean-up after the product no longer shows them
                toast(creating ? t('pe.created') : t('pe.saved'));
                if (creating) ctx.router.navigate(`/products/${encodeURIComponent(id)}`, { replace: true });
                else ctx.router.reload();
              } catch (e) {
                if (e && e.code === 'invalid') {
                  S = { ...S, ...form0 };                                                                // keep what was typed
                  showErrors(e.errors, e.variantErrors);
                  toastError(t('pe.fixErrors'));
                } else { if (!isRefusal(e)) reportError(e, 'product.save'); toastError(explainError(e)); }
              }
            });
          },
        },
      }));

      // small DOM helpers used above
      function $$all(sel) { return [...ctx.el.querySelectorAll(sel)]; }
      function $$focusLast() { const inputs = $$all('#pe-specs [data-k="label"]'); const last = inputs[inputs.length - 1]; if (last) last.focus(); }
    });
  },
};
