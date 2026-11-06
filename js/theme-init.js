/* Applies the saved theme before first paint (classic script, loaded synchronously in <head>). */
(function () {
  try {
    var admin = location.pathname.indexOf('/admin') === 0;
    var v = JSON.parse(localStorage.getItem(admin ? 'sv.admin.theme' : 'sv.theme'));
    if (v === 'dark' || v === 'light') document.documentElement.setAttribute('data-theme', v);
  } catch (e) { /* storage blocked: system theme */ }
})();
