/* Small helpers shared by the click-through scenarios in tests/e2e/flows/*.mjs */
export const BTN = '#co-totals button[type="submit"]';                          // the checkout "place order" button
export const ready = (page) => page.waitForSelector(`${BTN}:not([disabled])`, { timeout: 12000 });
export const orderNo = (page) => new URL(page.url()).pathname.split('/').pop();
export const placeAndWait = async (page) => { await page.click(BTN); await page.waitForURL(/\/order-success\//, { timeout: 15000 }); return orderNo(page); };
export const topLevelOrders = async (f) => Object.keys(await f.docs('orders/')).filter((k) => k.split('/').length === 2);
export const cartLines = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('sv.cart.v2')).lines.length; } catch { return -1; } });
export const text = async (page, sel) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
/** dialogs opened by core/ui.js */
export const DLG = '[role="dialog"]';
export const YES = `${DLG} [data-yes]`;
