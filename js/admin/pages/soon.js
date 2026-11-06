/*
 * Placeholder for admin modules that are not part of this release (see docs/STATUS.md).
 * The navigation hides them (`soon: true` in nav.js); a typed URL lands here. Remove the flag and point the route at the real page when it exists.
 */
import { render } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { emptyState } from '../../core/ui.js';

registerBoth({
  'soon.title': ['This module is not part of this release', 'এই মডিউলটি এই রিলিজে নেই'],
  'soon.text': ['It is planned but not built yet. Until then this data can be managed in the Firebase console.', 'এটি পরিকল্পনায় আছে, কিন্তু এখনো তৈরি হয়নি। ততদিন এই ডেটা Firebase কনসোল থেকে ম্যানেজ করা যাবে।'],
});

export default {
  mount(ctx) {
    render(ctx.el, emptyState({ icon: 'clock', title: t('soon.title'), text: t('soon.text'), action: { label: t('admin.goDashboard'), href: '#/dashboard' } }));
  },
};
