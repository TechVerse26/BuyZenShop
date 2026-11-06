/*
 * Shared constants — used by the storefront, the admin panel and the tests.
 * Anything marked "mirrors firestore.rules" MUST stay identical to the rules file;
 * tests/unit/consistency.test.mjs parses firestore.rules and fails when they drift.
 */

export const APP = Object.freeze({
  name: 'Shop Verse',
  version: '2.0.0',
  schemaVersion: 2,            // order schema written by this code base (rules: schemaVersion == 2)
  currency: 'BDT',
  currencySymbol: '৳',
  timezone: 'Asia/Dhaka',
  utcOffsetMinutes: 360,
});

/* ───────────────────────── limits (mirror firestore.rules) ───────────────────────── */

export const LIMITS = Object.freeze({
  MAX_LINES: 5,                 // order lines per order (rules: lineOk(0..4))
  MAX_QTY_PER_LINE: 50,
  ORDER_COOLDOWN_SECONDS: 15,   // rules: users.lastOrderAt + 15 s
  MAX_PRICE: 100000000,
  MAX_CART_LINES: 60,           // rules: users/{uid}/cart items map size
  MAX_IMAGES: 12,
  MAX_VARIANTS: 40,
  MAX_OPTIONS: 3,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,   // storage.rules
  IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  ADMIN_BATCH_OPS: 18,          // staff batches: every staff write costs one rule access call (limit 20 per batch)
  CATALOG_CACHE_TTL_MS: 10 * 60 * 1000,
  REPORT_MAX_ORDERS: 5000,
});

/* ───────────────────────── roles & permissions (mirror firestore.rules rolePerms) ───────────────────────── */

export const ROLES = Object.freeze({
  super_admin:       { label: 'Super Admin',       bn: 'সুপার অ্যাডমিন',        about: 'Full access, including staff management and migrations.', aboutBn: 'সব অ্যাক্সেস — স্টাফ ম্যানেজমেন্ট ও মাইগ্রেশনসহ।' },
  store_admin:       { label: 'Store Admin',       bn: 'স্টোর অ্যাডমিন',        about: 'Runs the store day to day; cannot manage staff.', aboutBn: 'দৈনন্দিন স্টোর পরিচালনা; স্টাফ ম্যানেজ করতে পারে না।' },
  product_manager:   { label: 'Product Manager',   bn: 'প্রোডাক্ট ম্যানেজার',   about: 'Catalog, categories, brands, content, reviews.', aboutBn: 'ক্যাটালগ, ক্যাটাগরি, ব্র্যান্ড, কনটেন্ট, রিভিউ।' },
  order_manager:     { label: 'Order Manager',     bn: 'অর্ডার ম্যানেজার',      about: 'Orders, payment verification, shipping, customers.', aboutBn: 'অর্ডার, পেমেন্ট যাচাই, শিপিং, কাস্টমার।' },
  inventory_manager: { label: 'Inventory Manager', bn: 'ইনভেন্টরি ম্যানেজার',   about: 'Stock levels, adjustments, imports.', aboutBn: 'স্টক, সমন্বয়, ইমপোর্ট।' },
  customer_support:  { label: 'Customer Support',  bn: 'কাস্টমার সাপোর্ট',      about: 'Tickets, customer lookup, review moderation.', aboutBn: 'টিকিট, কাস্টমার খোঁজা, রিভিউ মডারেশন।' },
  reporting:         { label: 'Reporting',         bn: 'রিপোর্টিং',             about: 'Read-only reports and exports.', aboutBn: 'শুধু রিপোর্ট ও এক্সপোর্ট (দেখা)।' },
});
export const ROLE_IDS = Object.freeze(Object.keys(ROLES));

/** Permission id → {group, label}. super_admin implicitly has every permission (see rules perm()). */
export const PERMISSIONS = Object.freeze({
  'products.read':     { group: 'catalog',   label: 'View products (incl. drafts)' },
  'products.write':    { group: 'catalog',   label: 'Create / edit products' },
  'products.delete':   { group: 'catalog',   label: 'Delete products' },
  'costs.read':        { group: 'catalog',   label: 'See cost prices' },
  'categories.write':  { group: 'catalog',   label: 'Manage categories' },
  'brands.write':      { group: 'catalog',   label: 'Manage brands' },
  'inventory.read':    { group: 'inventory', label: 'View inventory & movements' },
  'inventory.adjust':  { group: 'inventory', label: 'Adjust stock' },
  'orders.read':       { group: 'orders',    label: 'View orders' },
  'orders.update':     { group: 'orders',    label: 'Update order status' },
  'orders.cancel':     { group: 'orders',    label: 'Cancel orders' },
  'orders.refund':     { group: 'orders',    label: 'Refund orders' },
  'payments.verify':   { group: 'orders',    label: 'Verify / reject payments' },
  'customers.read':    { group: 'customers', label: 'View customers' },
  'customers.write':   { group: 'customers', label: 'Edit customers (notes, restrictions)' },
  'coupons.read':      { group: 'marketing', label: 'View coupons' },
  'coupons.write':     { group: 'marketing', label: 'Manage coupons' },
  'shipping.write':    { group: 'marketing', label: 'Manage shipping zones' },
  'content.write':     { group: 'content',   label: 'Edit homepage & pages' },
  'reviews.moderate':  { group: 'content',   label: 'Moderate reviews' },
  'support.read':      { group: 'support',   label: 'View support tickets' },
  'support.reply':     { group: 'support',   label: 'Reply to tickets' },
  'reports.read':      { group: 'reports',   label: 'View reports' },
  'reports.export':    { group: 'reports',   label: 'Export CSV' },
  'settings.read':     { group: 'system',    label: 'View settings' },
  'settings.write':    { group: 'system',    label: 'Change settings' },
  'audit.read':        { group: 'system',    label: 'View audit log' },
  'mail.send':         { group: 'system',    label: 'Queue customer e-mails' },
  'staff.manage':      { group: 'system',    label: 'Manage staff & roles' },
  'migrate.run':       { group: 'system',    label: 'Run data migrations' },
});
export const PERMISSION_IDS = Object.freeze(Object.keys(PERMISSIONS));

// mirrors firestore.rules rolePerms()  (super_admin => everything)
export const ROLE_PERMS = Object.freeze({
  store_admin: [
    'products.read', 'products.write', 'products.delete', 'costs.read',
    'categories.write', 'brands.write', 'inventory.read', 'inventory.adjust',
    'orders.read', 'orders.update', 'orders.cancel', 'orders.refund', 'payments.verify',
    'customers.read', 'customers.write', 'coupons.read', 'coupons.write',
    'shipping.write', 'content.write', 'reviews.moderate', 'support.read', 'support.reply',
    'reports.read', 'reports.export', 'settings.read', 'settings.write', 'audit.read', 'mail.send',
  ],
  product_manager: [
    'products.read', 'products.write', 'products.delete', 'costs.read', 'categories.write',
    'brands.write', 'inventory.read', 'content.write', 'reviews.moderate', 'coupons.read',
  ],
  order_manager: [
    'orders.read', 'orders.update', 'orders.cancel', 'payments.verify', 'customers.read',
    'shipping.write', 'support.read', 'inventory.read', 'products.read', 'mail.send', 'coupons.read',
  ],
  inventory_manager: [
    'products.read', 'costs.read', 'inventory.read', 'inventory.adjust',
  ],
  customer_support: [
    'orders.read', 'customers.read', 'support.read', 'support.reply', 'reviews.moderate',
    'mail.send', 'products.read',
  ],
  reporting: [
    'reports.read', 'reports.export', 'products.read', 'inventory.read', 'orders.read',
  ],
});

/** Client-side permission check (UI gating only — the rules are the real enforcement). */
export function roleCan(role, perm) {
  if (!role) return false;
  if (role === 'super_admin') return true;
  const list = ROLE_PERMS[role];
  return !!list && list.includes(perm);
}

/* ───────────────────────── order lifecycle (mirrors rules validTransition) ───────────────────────── */

/** tone → css class suffix: neutral | info | warn | ok | bad */
export const ORDER_STATUS = Object.freeze({
  pending:          { label: 'Pending',          bn: 'অপেক্ষমাণ',          tone: 'warn',    stage: 0 },
  confirmed:        { label: 'Confirmed',        bn: 'নিশ্চিত',            tone: 'info',    stage: 1 },
  processing:       { label: 'Processing',       bn: 'প্রস্তুত হচ্ছে',      tone: 'info',    stage: 2 },
  packed:           { label: 'Packed',           bn: 'প্যাক হয়েছে',        tone: 'info',    stage: 3 },
  shipped:          { label: 'Shipped',          bn: 'পাঠানো হয়েছে',       tone: 'info',    stage: 4 },
  delivered:        { label: 'Delivered',        bn: 'ডেলিভারি হয়েছে',     tone: 'ok',      stage: 5 },
  cancelled:        { label: 'Cancelled',        bn: 'বাতিল',              tone: 'bad',     stage: -1 },
  return_requested: { label: 'Return requested', bn: 'রিটার্নের অনুরোধ',    tone: 'warn',    stage: 6 },
  returned:         { label: 'Returned',         bn: 'ফেরত এসেছে',         tone: 'neutral', stage: 7 },
  refund_pending:   { label: 'Refund pending',   bn: 'রিফান্ড বাকি',        tone: 'warn',    stage: 8 },
  refunded:         { label: 'Refunded',         bn: 'রিফান্ড হয়েছে',      tone: 'neutral', stage: 9 },
});
export const ORDER_STATUS_IDS = Object.freeze(Object.keys(ORDER_STATUS));

export const ORDER_TRANSITIONS = Object.freeze({
  pending:          ['confirmed', 'processing', 'cancelled'],
  confirmed:        ['processing', 'cancelled'],
  processing:       ['packed', 'shipped', 'delivered', 'cancelled'],
  packed:           ['shipped', 'cancelled'],
  shipped:          ['delivered', 'returned'],
  delivered:        ['return_requested', 'refund_pending'],
  return_requested: ['returned', 'delivered', 'refund_pending'],
  returned:         ['refund_pending', 'refunded'],
  refund_pending:   ['refunded'],
  cancelled:        [],
  refunded:         [],
});

/** Stages from which stock is still only *reserved* (not yet physically shipped). */
export const RESERVED_STATUSES = Object.freeze(['pending', 'confirmed', 'processing', 'packed']);
/** Statuses that count as revenue in reports (payment is tracked separately). */
export const REVENUE_STATUSES = Object.freeze(['confirmed', 'processing', 'packed', 'shipped', 'delivered']);
export const OPEN_STATUSES = Object.freeze(['pending', 'confirmed', 'processing', 'packed', 'shipped', 'return_requested', 'refund_pending']);

/* ───────────────────────── payments ───────────────────────── */

export const PAYMENT_METHODS = Object.freeze({
  cod:   { label: 'Cash on Delivery', bn: 'ক্যাশ অন ডেলিভারি', manual: false, online: false },
  bkash: { label: 'bKash',            bn: 'বিকাশ',             manual: true,  online: false },
  nagad: { label: 'Nagad',            bn: 'নগদ',               manual: true,  online: false },
});
export const PAYMENT_METHOD_IDS = Object.freeze(Object.keys(PAYMENT_METHODS));

/**
 * unpaid                – COD, nothing received yet
 * awaiting_verification – customer sent money and entered a TrxID; NOT proof of payment
 * paid                  – staff verified the transaction (or COD cash collected)
 * failed                – staff could not verify; customer may submit another TrxID
 * refunded              – money returned
 */
export const PAYMENT_STATUS = Object.freeze({
  unpaid:                { label: 'Unpaid',                bn: 'অপরিশোধিত',        tone: 'neutral' },
  awaiting_verification: { label: 'Awaiting verification', bn: 'যাচাইয়ের অপেক্ষায়', tone: 'warn' },
  paid:                  { label: 'Paid',                  bn: 'পরিশোধিত',         tone: 'ok' },
  failed:                { label: 'Failed',                bn: 'ব্যর্থ',            tone: 'bad' },
  refunded:              { label: 'Refunded',              bn: 'ফেরত দেওয়া হয়েছে', tone: 'neutral' },
});

/** Support tickets: customers create "open"; staff set "answered" / "closed". A customer reply re-opens the ticket. */
export const TICKET_STATUS = Object.freeze({
  open:     { label: 'Open',     bn: 'খোলা',      tone: 'warn' },
  answered: { label: 'Answered', bn: 'উত্তর দেওয়া', tone: 'info' },
  closed:   { label: 'Closed',   bn: 'বন্ধ',       tone: 'neutral' },
});
export const TICKET_STATUS_IDS = Object.freeze(Object.keys(TICKET_STATUS));

/** Regexes mirror firestore.rules. */
export const PATTERNS = Object.freeze({
  bdPhone: /^01[3-9][0-9]{8}$/,
  trxId: /^[A-Z0-9]{6,20}$/,
  orderNumber: /^[A-Z0-9]{2,6}-[0-9]{6}-[A-Z0-9]{6}$/,
  couponCode: /^[A-Z0-9-]{3,24}$/,
  slug: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  email: /^[^@ ]+@[^@ ]+[.][^@ ]+$/,
});

/* ───────────────────────── catalog ───────────────────────── */

export const PRODUCT_STATUS = Object.freeze({
  draft:     { label: 'Draft',     bn: 'ড্রাফট',    tone: 'neutral' },
  published: { label: 'Published', bn: 'প্রকাশিত',  tone: 'ok' },
  archived:  { label: 'Archived',  bn: 'আর্কাইভ',   tone: 'warn' },
});
export const PRODUCT_TYPES = Object.freeze(['simple', 'variable']);

export const COUPON_TYPES = Object.freeze({
  percent:       { label: 'Percentage',    bn: 'শতকরা ছাড়' },
  fixed:         { label: 'Fixed amount',  bn: 'নির্দিষ্ট পরিমাণ ছাড়' },
  free_shipping: { label: 'Free shipping', bn: 'ফ্রি শিপিং' },
});
export const COUPON_APPLIES = Object.freeze(['all', 'products', 'categories']);

export const INVENTORY_MOVEMENT_TYPES = Object.freeze({
  adjust:      { label: 'Manual adjustment', bn: 'ম্যানুয়াল সমন্বয়' },
  receive:     { label: 'Stock received',    bn: 'স্টক এসেছে' },
  ship:        { label: 'Shipped',           bn: 'শিপ হয়েছে' },
  return:      { label: 'Return restock',    bn: 'রিটার্ন থেকে স্টক' },
  correction:  { label: 'Correction',        bn: 'সংশোধন' },
  import:      { label: 'CSV import',        bn: 'CSV ইমপোর্ট' },
  reserve_fix: { label: 'Reservation recount', bn: 'রিজার্ভেশন পুনর্গণনা' },
  initial:     { label: 'Initial stock',     bn: 'প্রারম্ভিক স্টক' },
});

/* ───────────────────────── Bangladesh districts (canonical English → Bengali) ───────────────────────── */

export const DIVISIONS = Object.freeze({
  Dhaka: ['Dhaka', 'Faridpur', 'Gazipur', 'Gopalganj', 'Kishoreganj', 'Madaripur', 'Manikganj', 'Munshiganj', 'Narayanganj', 'Narsingdi', 'Rajbari', 'Shariatpur', 'Tangail'],
  Chattogram: ['Bandarban', 'Brahmanbaria', 'Chandpur', 'Chattogram', 'Cumilla', "Cox's Bazar", 'Feni', 'Khagrachhari', 'Lakshmipur', 'Noakhali', 'Rangamati'],
  Rajshahi: ['Bogura', 'Joypurhat', 'Naogaon', 'Natore', 'Chapainawabganj', 'Pabna', 'Rajshahi', 'Sirajganj'],
  Khulna: ['Bagerhat', 'Chuadanga', 'Jashore', 'Jhenaidah', 'Khulna', 'Kushtia', 'Magura', 'Meherpur', 'Narail', 'Satkhira'],
  Barishal: ['Barguna', 'Barishal', 'Bhola', 'Jhalokathi', 'Patuakhali', 'Pirojpur'],
  Sylhet: ['Habiganj', 'Moulvibazar', 'Sunamganj', 'Sylhet'],
  Rangpur: ['Dinajpur', 'Gaibandha', 'Kurigram', 'Lalmonirhat', 'Nilphamari', 'Panchagarh', 'Rangpur', 'Thakurgaon'],
  Mymensingh: ['Jamalpur', 'Mymensingh', 'Netrokona', 'Sherpur'],
});

export const DISTRICT_BN = Object.freeze({
  Dhaka: 'ঢাকা', Faridpur: 'ফরিদপুর', Gazipur: 'গাজীপুর', Gopalganj: 'গোপালগঞ্জ', Kishoreganj: 'কিশোরগঞ্জ', Madaripur: 'মাদারীপুর',
  Manikganj: 'মানিকগঞ্জ', Munshiganj: 'মুন্সিগঞ্জ', Narayanganj: 'নারায়ণগঞ্জ', Narsingdi: 'নরসিংদী', Rajbari: 'রাজবাড়ী',
  Shariatpur: 'শরীয়তপুর', Tangail: 'টাঙ্গাইল',
  Bandarban: 'বান্দরবান', Brahmanbaria: 'ব্রাহ্মণবাড়িয়া', Chandpur: 'চাঁদপুর', Chattogram: 'চট্টগ্রাম', Cumilla: 'কুমিল্লা',
  "Cox's Bazar": 'কক্সবাজার', Feni: 'ফেনী', Khagrachhari: 'খাগড়াছড়ি', Lakshmipur: 'লক্ষ্মীপুর', Noakhali: 'নোয়াখালী', Rangamati: 'রাঙ্গামাটি',
  Bogura: 'বগুড়া', Joypurhat: 'জয়পুরহাট', Naogaon: 'নওগাঁ', Natore: 'নাটোর', Chapainawabganj: 'চাঁপাইনবাবগঞ্জ', Pabna: 'পাবনা',
  Rajshahi: 'রাজশাহী', Sirajganj: 'সিরাজগঞ্জ',
  Bagerhat: 'বাগেরহাট', Chuadanga: 'চুয়াডাঙ্গা', Jashore: 'যশোর', Jhenaidah: 'ঝিনাইদহ', Khulna: 'খুলনা', Kushtia: 'কুষ্টিয়া',
  Magura: 'মাগুরা', Meherpur: 'মেহেরপুর', Narail: 'নড়াইল', Satkhira: 'সাতক্ষীরা',
  Barguna: 'বরগুনা', Barishal: 'বরিশাল', Bhola: 'ভোলা', Jhalokathi: 'ঝালকাঠি', Patuakhali: 'পটুয়াখালী', Pirojpur: 'পিরোজপুর',
  Habiganj: 'হবিগঞ্জ', Moulvibazar: 'মৌলভীবাজার', Sunamganj: 'সুনামগঞ্জ', Sylhet: 'সিলেট',
  Dinajpur: 'দিনাজপুর', Gaibandha: 'গাইবান্ধা', Kurigram: 'কুড়িগ্রাম', Lalmonirhat: 'লালমনিরহাট', Nilphamari: 'নীলফামারী',
  Panchagarh: 'পঞ্চগড়', Rangpur: 'রংপুর', Thakurgaon: 'ঠাকুরগাঁও',
  Jamalpur: 'জামালপুর', Mymensingh: 'ময়মনসিংহ', Netrokona: 'নেত্রকোণা', Sherpur: 'শেরপুর',
});

export const DISTRICTS = Object.freeze(Object.values(DIVISIONS).flat());

/* ───────────────────────── legacy values (pre-upgrade site) ───────────────────────── */

export const LEGACY = Object.freeze({
  voucherCode: 'SHOPVERSE',
  voucherPercent: 10,
  insideZoneName: 'Inside Sirajganj',
  insideZoneFee: 70,
  outsideZoneName: 'Outside Sirajganj',
  outsideZoneFee: 130,
  homeDistrict: 'Sirajganj',
  cartStorageKey: 'shopVerseCart',
  tawk: { propertyId: '6a3cb233f0750e1d459d0cbe', widgetId: '1jruhg6uv' },
});

/* ───────────────────────── storage keys ───────────────────────── */

export const STORAGE_KEYS = Object.freeze({
  cart: 'sv.cart.v2',
  lang: 'sv.lang',
  theme: 'sv.theme',
  catalog: 'sv.catalog.v2',
  recent: 'sv.recent',
  adminLang: 'sv.admin.lang',
  adminTheme: 'sv.admin.theme',
  pendingCoupon: 'sv.coupon',
});
