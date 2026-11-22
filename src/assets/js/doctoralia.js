// Carrega o bloco de agendamento da Doctoralia no lugar do link #zl-url.
// Se o script externo falhar, o link continua funcionando como botão.
(() => {
  if (document.getElementById('zl-widget-s')) return;
  const js = document.createElement('script');
  js.id = 'zl-widget-s';
  js.src = 'https://platform.docplanner.com/js/widget.js';
  js.async = true;
  document.head.appendChild(js);
})();
