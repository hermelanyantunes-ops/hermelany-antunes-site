// Medição do Google — só é carregada se "googleAnalyticsId" ou "googleAdsId" estiver preenchido em src/config/site.json.
//
// Google Ads: mede duas conversões, sem coletar dados de quem visita:
//   - clique em qualquer botão de WhatsApp (links wa.me)
//   - interação com a agenda da Doctoralia (link para a Doctoralia ou clique dentro do quadro da agenda)
// A personalização de anúncios (remarketing) fica desligada: saúde é categoria sensível no Google.
(() => {
  const el = document.currentScript;
  if (!el) return;
  const ga = el.dataset.ga || '';
  const ads = el.dataset.ads || '';
  const convWa = el.dataset.convWa || '';
  const convAgenda = el.dataset.convAgenda || '';
  const temGa = /^G-[A-Z0-9]+$/.test(ga);
  const temAds = /^AW-\d+$/.test(ads);
  if (!temGa && !temAds) return;

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${temAds ? ads : ga}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  if (temGa) window.gtag('config', ga, { anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false });
  if (temAds) window.gtag('config', ads, { allow_ad_personalization_signals: false });
  if (!temAds) return;

  // Cada conversão conta no máximo uma vez por página aberta.
  const enviadas = new Set();
  const converter = (rotulo) => {
    if (!rotulo || enviadas.has(rotulo)) return;
    enviadas.add(rotulo);
    window.gtag('event', 'conversion', { send_to: rotulo, transport_type: 'beacon' });
  };

  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(href)) converter(convWa);
    else if (/doctoralia\.com\.br/.test(href)) converter(convAgenda);
  }, { capture: true });

  // O quadro da agenda é de outro site: o clique dentro dele aparece como perda de foco da página.
  window.addEventListener('blur', () => {
    setTimeout(() => {
      const f = document.activeElement;
      if (f && f.tagName === 'IFRAME' && /doctoralia|docplanner/.test(f.src || '')) converter(convAgenda);
    }, 0);
  });
})();
