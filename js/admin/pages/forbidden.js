/* "No access" and "page not found" screen (the router's notFound route points here too). */
import { render } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { emptyState } from '../../core/ui.js';

export default {
  mount(ctx) {
    const missing = ctx.route.meta && ctx.route.meta.notFound;
    render(ctx.el, emptyState({
      icon: missing ? 'search' : 'lock',
      title: missing ? t('admin.notFound') : t('admin.noAccessTitle'),
      text: missing ? '' : t('admin.noAccessText'),
      action: { label: t('admin.goDashboard'), href: '#/dashboard' },
    }));
  },
};
