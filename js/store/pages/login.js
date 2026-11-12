/*
 * /login?next=/checkout&mode=signup — the full-page sign-in / sign-up form (the same form as the popup).
 * Signed-in visitors are sent straight on; `next` is only honoured when it is a same-site path.
 */
import { html, render, setMeta } from '../../core/dom.js';
import { spinnerBlock } from '../../core/ui.js';
import { whenAuthReady, isSignedIn } from '../../data/auth.js';
import { mountAuthForm, authTitle } from '../components/authModal.js';
import { safeNext } from '../lib/links.js';

export default {
  async mount(ctx) {
    const next = safeNext(ctx.query.next, '/account');
    const mode = ctx.query.mode === 'signup' ? 'signup' : 'signin';
    setMeta({ title: authTitle(mode), noindex: true });
    render(ctx.el, html`<div class="container page">${spinnerBlock()}</div>`);

    await Promise.race([whenAuthReady(), new Promise((r) => setTimeout(r, 6000))]);
    if (ctx.signal.aborted) return;
    if (isSignedIn()) { ctx.router.navigate(next, { replace: true }); return; }

    render(ctx.el, html`<div class="container page login"><div class="login-card"><div id="login-form"></div></div></div>`);
    const host = ctx.el.querySelector('#login-form');
    const dispose = mountAuthForm(host, {
      mode,
      onDone: () => ctx.router.navigate(next, { replace: true }),
      onMode: (m) => setMeta({ title: authTitle(m), noindex: true }),
    });
    ctx.cleanup(dispose);
  },
};
