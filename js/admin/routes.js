/*
 * Admin route table (hash routes: /admin/#/orders/SV-261026-ABC123).
 * meta.perm   permission (or any-of list) required; null = any active staff member
 * meta.title  [English, Bengali] shown in the top bar and document title
 * meta.nav    nav item id to highlight
 * Several URL shapes may share one page file; the page reads ctx.params / ctx.route.meta.
 * PENDING modules (not built yet) load pages/soon.js; when one is built, point its routes back at the real page and drop `soon: true` in nav.js.
 *   pending: reports, customers, coupons, shipping, reviews, support, taxonomy, content-home, content-pages, audit
 */
export const routes = [
  { path: '/', load: () => import('./pages/dashboard.js'), meta: { nav: 'dashboard', perm: null, title: ['Dashboard', 'ড্যাশবোর্ড'] } },
  { path: '/dashboard', load: () => import('./pages/dashboard.js'), meta: { nav: 'dashboard', perm: null, title: ['Dashboard', 'ড্যাশবোর্ড'] } },
  { path: '/reports', load: () => import('./pages/soon.js'), meta: { nav: 'reports', perm: 'reports.read', title: ['Reports', 'রিপোর্ট'] } },

  { path: '/orders', load: () => import('./pages/orders.js'), meta: { nav: 'orders', perm: 'orders.read', title: ['Orders', 'অর্ডার'] } },
  { path: '/orders/:id', load: () => import('./pages/order-detail.js'), meta: { nav: 'orders', perm: 'orders.read', title: ['Order', 'অর্ডার'] } },
  { path: '/customers', load: () => import('./pages/soon.js'), meta: { nav: 'customers', perm: 'customers.read', title: ['Customers', 'কাস্টমার'] } },
  { path: '/customers/:id', load: () => import('./pages/soon.js'), meta: { nav: 'customers', perm: 'customers.read', title: ['Customer', 'কাস্টমার'] } },
  { path: '/coupons', load: () => import('./pages/soon.js'), meta: { nav: 'coupons', perm: 'coupons.read', title: ['Coupons', 'কুপন'] } },
  { path: '/shipping', load: () => import('./pages/soon.js'), meta: { nav: 'shipping', perm: 'shipping.write', title: ['Shipping', 'শিপিং'] } },
  { path: '/reviews', load: () => import('./pages/soon.js'), meta: { nav: 'reviews', perm: 'reviews.moderate', title: ['Reviews', 'রিভিউ'] } },
  { path: '/support', load: () => import('./pages/soon.js'), meta: { nav: 'support', perm: 'support.read', title: ['Support', 'সাপোর্ট'] } },
  { path: '/support/:id', load: () => import('./pages/soon.js'), meta: { nav: 'support', perm: 'support.read', title: ['Ticket', 'টিকিট'] } },

  { path: '/products', load: () => import('./pages/products.js'), meta: { nav: 'products', perm: 'products.read', title: ['Products', 'প্রোডাক্ট'] } },
  { path: '/products/new', load: () => import('./pages/product-edit.js'), meta: { nav: 'products', perm: 'products.write', title: ['New product', 'নতুন প্রোডাক্ট'] } },
  { path: '/products/:id', load: () => import('./pages/product-edit.js'), meta: { nav: 'products', perm: 'products.read', title: ['Edit product', 'প্রোডাক্ট সম্পাদনা'] } },
  { path: '/categories', load: () => import('./pages/soon.js'), meta: { nav: 'categories', perm: 'products.read', kind: 'categories', title: ['Categories', 'ক্যাটাগরি'] } },
  { path: '/brands', load: () => import('./pages/soon.js'), meta: { nav: 'brands', perm: 'products.read', kind: 'brands', title: ['Brands', 'ব্র্যান্ড'] } },
  { path: '/inventory', load: () => import('./pages/inventory.js'), meta: { nav: 'inventory', perm: 'inventory.read', title: ['Inventory', 'ইনভেন্টরি'] } },

  { path: '/content', load: () => import('./pages/soon.js'), meta: { nav: 'content-home', perm: 'content.write', title: ['Homepage', 'হোমপেজ'] } },
  { path: '/content/pages', load: () => import('./pages/soon.js'), meta: { nav: 'content-pages', perm: 'content.write', title: ['Pages', 'পেজ'] } },

  { path: '/settings', load: () => import('./pages/settings.js'), meta: { nav: 'settings', perm: 'settings.read', title: ['Settings', 'সেটিংস'] } },
  { path: '/staff', load: () => import('./pages/staff.js'), meta: { nav: 'staff', perm: 'staff.manage', title: ['Staff & roles', 'স্টাফ ও রোল'] } },
  { path: '/audit', load: () => import('./pages/soon.js'), meta: { nav: 'audit', perm: 'audit.read', title: ['Audit log', 'অডিট লগ'] } },
  { path: '/setup', load: () => import('./pages/setup.js'), meta: { nav: 'setup', perm: null, title: ['Setup & migration', 'সেটআপ ও মাইগ্রেশন'] } },
  { path: '/forbidden', load: () => import('./pages/forbidden.js'), meta: { perm: null, title: ['No access', 'অনুমতি নেই'] } },
];

export const notFound = { load: () => import('./pages/forbidden.js'), meta: { perm: null, title: ['Not found', 'পাওয়া যায়নি'], notFound: true } };
