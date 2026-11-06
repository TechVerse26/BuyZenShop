/*
 * Admin navigation manifest. `perm` = permission (or list: any-of) required to see the item;
 * null = every active staff member. Labels are [English, Bengali].
 * Routes + the page files they load are in routes.js; the rules enforce permissions server-side.
 */
export const NAV = [
  { group: ['Overview', 'ওভারভিউ'], items: [
    { id: 'dashboard', path: '/dashboard', icon: 'dashboard', label: ['Dashboard', 'ড্যাশবোর্ড'], perm: null },
    { id: 'reports', path: '/reports', icon: 'bar-chart', label: ['Reports', 'রিপোর্ট'], perm: 'reports.read', soon: true },
  ] },
  { group: ['Sales', 'বিক্রয়'], items: [
    { id: 'orders', path: '/orders', icon: 'receipt', label: ['Orders', 'অর্ডার'], perm: 'orders.read' },
    { id: 'customers', path: '/customers', icon: 'users', label: ['Customers', 'কাস্টমার'], perm: 'customers.read', soon: true },
    { id: 'coupons', path: '/coupons', icon: 'percent', label: ['Coupons', 'কুপন'], perm: 'coupons.read', soon: true },
    { id: 'shipping', path: '/shipping', icon: 'truck', label: ['Shipping', 'শিপিং'], perm: 'shipping.write', soon: true },
    { id: 'reviews', path: '/reviews', icon: 'star', label: ['Reviews', 'রিভিউ'], perm: 'reviews.moderate', soon: true },
    { id: 'support', path: '/support', icon: 'headset', label: ['Support', 'সাপোর্ট'], perm: 'support.read', soon: true },
  ] },
  { group: ['Catalog', 'ক্যাটালগ'], items: [
    { id: 'products', path: '/products', icon: 'package', label: ['Products', 'প্রোডাক্ট'], perm: 'products.read' },
    { id: 'categories', path: '/categories', icon: 'layers', label: ['Categories', 'ক্যাটাগরি'], perm: 'products.read', soon: true },
    { id: 'brands', path: '/brands', icon: 'tag', label: ['Brands', 'ব্র্যান্ড'], perm: 'products.read', soon: true },
    { id: 'inventory', path: '/inventory', icon: 'archive', label: ['Inventory', 'ইনভেন্টরি'], perm: 'inventory.read' },
  ] },
  { group: ['Content', 'কনটেন্ট'], items: [
    { id: 'content-home', path: '/content', icon: 'home', label: ['Homepage', 'হোমপেজ'], perm: 'content.write', soon: true },
    { id: 'content-pages', path: '/content/pages', icon: 'file-text', label: ['Pages', 'পেজ'], perm: 'content.write', soon: true },
  ] },
  { group: ['System', 'সিস্টেম'], items: [
    { id: 'settings', path: '/settings', icon: 'settings', label: ['Settings', 'সেটিংস'], perm: 'settings.read' },
    { id: 'staff', path: '/staff', icon: 'key', label: ['Staff & roles', 'স্টাফ ও রোল'], perm: 'staff.manage' },
    { id: 'audit', path: '/audit', icon: 'history', label: ['Audit log', 'অডিট লগ'], perm: 'audit.read', soon: true },
    { id: 'setup', path: '/setup', icon: 'database', label: ['Setup & migration', 'সেটআপ ও মাইগ্রেশন'], perm: null },
  ] },
];
