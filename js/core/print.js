/*
 * Printable documents: invoice, packing slip, shipping label — shared by the admin panel (orders) and the
 * customer's account page (invoice of their own order).
 *
 *   printDocument(invoiceHtml(order, { business }), { title: 'Invoice SV-…' })      // opens the print dialog
 *   const doc = invoiceHtml(order, { business, lang: 'en' })                          // SafeHtml, e.g. to preview in a modal
 *   const business = businessFrom(settings(), privateSettingsOrNull)
 *
 * `order` is the output of normalizeOrder() (works for legacy orders too).
 * Printing happens inside a hidden iframe (srcdoc) with its own small stylesheet, so it never depends on the
 * page's CSS and nothing from the app chrome leaks onto the paper.
 */
import { html, esc, safeUrl } from './dom.js';
import { getLang } from './i18n.js';
import { money, fmtDateTime, fmtDate } from './format.js';
import { PAYMENT_METHODS, PAYMENT_STATUS, ORDER_STATUS, DISTRICT_BN } from '../shared/constants.js';


/* ───────────────────────── helpers ───────────────────────── */

/** Business block for invoices: public settings + (staff only) private invoice settings. */
export function businessFrom(pub = {}, priv = null) {
  const inv = (priv && priv.invoice) || {};
  const c = pub.contact || {};
  return {
    name: inv.businessName || pub.storeName || 'Shop Verse',
    address: inv.address || c.address || '',
    phone: inv.phone || c.phone || (c.whatsapp ? `+${String(c.whatsapp).replace(/^\+/, '')}` : ''),
    email: c.email || '',
    note: inv.note || '',
    logoUrl: pub.logoUrl || '',
  };
}

function addressLines(a, lang) {
  const district = lang === 'bn' ? (DISTRICT_BN[a.district] || a.district) : a.district;
  return [a.line1, [a.area, a.upazila].filter(Boolean).join(', '), [district, a.postalCode].filter(Boolean).join(' ')].filter(Boolean);
}

const methodLabel = (m, lang) => { const e = PAYMENT_METHODS[m]; return e ? (lang === 'bn' ? e.bn : e.label) : String(m || ''); };
const payStatusLabel = (s, lang) => { const e = PAYMENT_STATUS[s]; return e ? (lang === 'bn' ? e.bn : e.label) : String(s || ''); };
const orderStatusLabel = (s, lang) => { const e = ORDER_STATUS[s]; return e ? (lang === 'bn' ? e.bn : e.label) : String(s || ''); };

/** Amount the courier / shop still has to collect. */
export function amountDue(order) {
  const p = order.payment || {};
  if (p.status === 'paid' || p.status === 'refunded') return 0;
  return Math.max(0, Number(order.totals?.total) || 0);
}

/* ───────────────────────── documents ───────────────────────── */

export function invoiceHtml(order, { business = {}, lang = getLang() } = {}) {
  const L = (en, bn) => (lang === 'bn' ? bn : en);
  const a = order.address || {};
  const c = order.customer || {};
  const p = order.payment || {};
  const tot = order.totals || {};
  const due = amountDue(order);
  return html`<div class="sheet">
    <header class="head">
      <div class="brand">
        ${business.logoUrl ? html`<img class="logo" src="${safeUrl(business.logoUrl)}" alt="">` : ''}
        <div>
          <div class="biz">${business.name || ''}</div>
          <div class="muted">${[business.address, business.phone, business.email].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <div class="meta">
        <div class="doc">${L('Invoice', 'ইনভয়েস')}</div>
        <table class="kv">
          <tr><th>${L('Order', 'অর্ডার')}</th><td class="mono">${order.orderNumber}</td></tr>
          <tr><th>${L('Date', 'তারিখ')}</th><td>${fmtDateTime(order.createdAtMs)}</td></tr>
          <tr><th>${L('Status', 'স্ট্যাটাস')}</th><td>${orderStatusLabel(order.status, lang)}</td></tr>
        </table>
      </div>
    </header>

    <section class="cols">
      <div>
        <h3>${L('Bill to / Ship to', 'বিল ও ডেলিভারির ঠিকানা')}</h3>
        <div class="strong">${a.name || c.name || ''}</div>
        <div>${a.phone || c.phone || ''}</div>
        ${addressLines(a, lang).map((l) => html`<div>${l}</div>`)}
      </div>
      <div>
        <h3>${L('Payment', 'পেমেন্ট')}</h3>
        <div>${methodLabel(p.method, lang)} · <span class="strong">${payStatusLabel(p.status, lang)}</span></div>
        ${p.trxId ? html`<div>${L('Transaction ID', 'ট্রানজেকশন আইডি')}: <span class="mono">${p.trxId}</span></div>` : ''}
        ${p.senderNumber ? html`<div>${L('Sender number', 'প্রেরকের নম্বর')}: <span class="mono">${p.senderNumber}</span></div>` : ''}
        ${order.zoneName ? html`<div class="muted">${order.zoneName}</div>` : ''}
      </div>
    </section>

    <table class="items">
      <thead><tr><th class="idx">#</th><th>${L('Item', 'পণ্য')}</th><th class="num">${L('Unit price', 'একক দাম')}</th><th class="num">${L('Qty', 'পরিমাণ')}</th><th class="num">${L('Amount', 'পরিমাণ')}</th></tr></thead>
      <tbody>
        ${order.items.map((l, i) => html`<tr>
          <td class="idx">${i + 1}</td>
          <td><div class="strong">${l.name}</div>${l.variantLabel ? html`<div class="muted">${l.variantLabel}</div>` : ''}${l.sku ? html`<div class="muted mono">${l.sku}</div>` : ''}</td>
          <td class="num">${money(l.unitPrice)}${l.regularPrice > l.unitPrice ? html` <s class="muted">${money(l.regularPrice)}</s>` : ''}</td>
          <td class="num">${l.qty}</td>
          <td class="num">${money(l.lineTotal)}</td>
        </tr>`)}
      </tbody>
    </table>

    <table class="totals">
      <tr><th>${L('Subtotal', 'সাবটোটাল')}</th><td class="num">${money(tot.subtotal)}</td></tr>
      ${tot.discount > 0 ? html`<tr><th>${L('Discount', 'ছাড়')}${order.couponCode ? html` (${order.couponCode})` : ''}</th><td class="num">− ${money(tot.discount)}</td></tr>` : ''}
      <tr><th>${L('Delivery charge', 'ডেলিভারি চার্জ')}</th><td class="num">${tot.shipping > 0 ? money(tot.shipping) : L('Free', 'ফ্রি')}</td></tr>
      <tr class="grand"><th>${L('Total', 'সর্বমোট')}</th><td class="num">${money(tot.total)}</td></tr>
      ${p.status === 'paid' ? html`<tr><th>${L('Paid', 'পরিশোধিত')}</th><td class="num">${money(tot.total)}</td></tr>` : ''}
      <tr><th>${L('Amount due', 'বাকি')}</th><td class="num strong">${money(due)}</td></tr>
    </table>

    ${order.notes?.customer ? html`<div class="note"><span class="strong">${L('Customer note', 'কাস্টমারের নোট')}:</span> ${order.notes.customer}</div>` : ''}
    <footer class="foot">${business.note || L('Thank you for shopping with us.', 'আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।')}</footer>
  </div>`;
}

export function packingSlipHtml(order, { business = {}, lang = getLang() } = {}) {
  const L = (en, bn) => (lang === 'bn' ? bn : en);
  const a = order.address || {};
  const c = order.customer || {};
  return html`<div class="sheet">
    <header class="head">
      <div class="brand"><div><div class="biz">${business.name || ''}</div><div class="muted">${L('Packing slip', 'প্যাকিং স্লিপ')}</div></div></div>
      <div class="meta"><div class="doc mono">${order.orderNumber}</div><div class="muted">${fmtDate(order.createdAtMs)}</div></div>
    </header>
    <section class="cols">
      <div>
        <h3>${L('Deliver to', 'প্রাপক')}</h3>
        <div class="strong">${a.name || c.name || ''}</div><div>${a.phone || c.phone || ''}</div>
        ${addressLines(a, lang).map((l) => html`<div>${l}</div>`)}
      </div>
      <div>
        <h3>${L('Payment', 'পেমেন্ট')}</h3>
        <div>${methodLabel(order.payment?.method, lang)} · ${payStatusLabel(order.payment?.status, lang)}</div>
        <div class="strong">${L('Collect cash', 'নগদ আদায় করুন')}: ${money(amountDue(order))}</div>
      </div>
    </section>
    <table class="items">
      <thead><tr><th class="idx">✓</th><th>${L('Item', 'পণ্য')}</th><th>${L('SKU', 'এসকেইউ')}</th><th class="num">${L('Qty', 'পরিমাণ')}</th></tr></thead>
      <tbody>${order.items.map((l) => html`<tr>
        <td class="idx"><span class="box"></span></td>
        <td><div class="strong">${l.name}</div>${l.variantLabel ? html`<div class="muted">${l.variantLabel}</div>` : ''}</td>
        <td class="mono">${l.sku || ''}</td><td class="num strong">${l.qty}</td></tr>`)}</tbody>
    </table>
    ${order.notes?.customer ? html`<div class="note"><span class="strong">${L('Customer note', 'কাস্টমারের নোট')}:</span> ${order.notes.customer}</div>` : ''}
  </div>`;
}

/** 100 × 150 mm label (use printDocument(..., { paper: 'label' })). */
export function shippingLabelHtml(order, { business = {}, lang = getLang() } = {}) {
  const L = (en, bn) => (lang === 'bn' ? bn : en);
  const a = order.address || {};
  const c = order.customer || {};
  const due = amountDue(order);
  const units = order.items.reduce((s, l) => s + l.qty, 0);
  return html`<div class="label">
    <div class="from muted">${L('From', 'প্রেরক')}: ${business.name || ''}${business.phone ? ` · ${business.phone}` : ''}</div>
    <div class="to">
      <div class="muted">${L('Deliver to', 'প্রাপক')}</div>
      <div class="big">${a.name || c.name || ''}</div>
      <div class="big mono">${a.phone || c.phone || ''}</div>
      ${addressLines(a, lang).map((l) => html`<div>${l}</div>`)}
    </div>
    <div class="cod ${due > 0 ? 'due' : 'paid'}">${due > 0 ? html`${L('Collect cash', 'নগদ আদায় করুন')}: <span class="amt">${money(due)}</span>` : L('PREPAID — do not collect', 'পরিশোধিত — টাকা নেবেন না')}</div>
    <div class="foot2"><span class="mono strong">${order.orderNumber}</span><span>${L('Items', 'আইটেম')}: ${units}</span></div>
  </div>`;
}

/* ───────────────────────── printing ───────────────────────── */

const PRINT_CSS = `
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111;font:13px/1.5 "Hind Siliguri",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.sheet{max-width:780px;margin:0 auto;padding:8px}
.head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:14px}
.brand{display:flex;gap:12px;align-items:center}.logo{height:44px;width:auto;max-width:120px;object-fit:contain}
.biz{font-size:20px;font-weight:700}.doc{font-size:20px;font-weight:700;text-align:end}.meta{text-align:end}
.muted{color:#555;font-size:12px}.strong{font-weight:600}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.kv{border-collapse:collapse;margin-inline-start:auto}.kv th{font-weight:500;color:#555;text-align:start;padding:1px 10px 1px 0}.kv td{padding:1px 0;text-align:end}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:14px}.cols h3{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#555}
table{width:100%;border-collapse:collapse}.items th{background:#f3f3f3;font-size:12px;text-align:start}.items th,.items td{border-bottom:1px solid #ccc;padding:6px 8px;vertical-align:top}
.num{text-align:end;white-space:nowrap}.idx{width:34px;text-align:center}.box{display:inline-block;width:14px;height:14px;border:1.5px solid #111;border-radius:2px}
.totals{width:300px;margin:12px 0 0 auto}.totals th{text-align:start;font-weight:500;padding:3px 8px}.totals td{padding:3px 8px}.totals .grand th,.totals .grand td{border-top:2px solid #111;font-size:15px;font-weight:700;padding-top:6px}
.note{margin-top:14px;padding:8px 10px;border:1px solid #ccc;border-radius:4px}.foot{margin-top:22px;padding-top:10px;border-top:1px solid #ccc;text-align:center;color:#555;font-size:12px}
.label{width:92mm;margin:0 auto;border:2px solid #111;padding:4mm;display:flex;flex-direction:column;gap:3mm;min-height:138mm}
.label .big{font-size:17px;font-weight:700}.label .cod{border:2px solid #111;padding:3mm;text-align:center;font-weight:700;font-size:14px}.label .cod.due .amt{font-size:22px}
.label .foot2{display:flex;justify-content:space-between;margin-top:auto;border-top:1px solid #111;padding-top:2mm}.label .from{border-bottom:1px solid #999;padding-bottom:2mm}
@media print{.sheet{max-width:none;padding:0}.sheet+.sheet{break-before:page;page-break-before:always}a{color:inherit;text-decoration:none}}
`;

const PAPER_CSS = {
  A4: '@page{size:A4;margin:12mm}',
  A5: '@page{size:A5;margin:10mm}',
  label: '@page{size:100mm 150mm;margin:3mm}',
};

/**
 * Print a SafeHtml document through a hidden iframe. Resolves once the dialog was requested.
 * (Browsers do not report whether the person actually printed or cancelled.)
 */
export function printDocument(body, { title = '', paper = 'A4', lang = getLang() } = {}) {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1; f.title = title || 'print';
    f.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    const bodyStr = typeof body === 'string' ? esc(body) : String(body);
    f.srcdoc = `<!doctype html><html lang="${lang === 'bn' ? 'bn' : 'en'}"><head><meta charset="utf-8"><title>${esc(title)}</title>`
      + `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap">`
      + `<style>${PAPER_CSS[paper] || PAPER_CSS.A4}${PRINT_CSS}</style></head><body>${bodyStr}</body></html>`;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; setTimeout(() => { f.remove(); resolve(); }, 1500); };
    f.addEventListener('load', async () => {
      try {
        const d = f.contentDocument;
        if (d && d.fonts && d.fonts.ready) await Promise.race([d.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
        f.contentWindow.focus(); f.contentWindow.print();
      } catch (e) { console.error('print failed', e); } finally { finish(); }
    });
    document.body.appendChild(f);
  });
}
