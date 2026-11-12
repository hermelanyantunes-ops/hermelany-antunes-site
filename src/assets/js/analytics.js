// Google Analytics 4 — só é carregado se "googleAnalyticsId" estiver preenchido em src/config/site.json
(() => {
  const el = document.currentScript;
  const id = el && el.dataset.ga;
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id, { anonymize_ip: true });
})();
