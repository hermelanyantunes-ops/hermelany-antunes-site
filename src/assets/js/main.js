// Navegação e pequenos comportamentos do site público
(() => {
  const topo = document.getElementById('topo');
  const botao = document.querySelector('.menu-botao');
  const painel = document.getElementById('menu-painel');

  if (botao && painel) {
    const fechar = () => {
      botao.setAttribute('aria-expanded', 'false');
      painel.classList.remove('aberto');
      document.body.style.overflow = '';
    };
    botao.addEventListener('click', () => {
      const aberto = botao.getAttribute('aria-expanded') === 'true';
      if (aberto) return fechar();
      botao.setAttribute('aria-expanded', 'true');
      painel.classList.add('aberto');
      document.body.style.overflow = 'hidden';
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
    painel.addEventListener('click', (e) => { if (e.target.closest('a')) fechar(); });
    window.matchMedia('(min-width: 1181px)').addEventListener('change', fechar);
  }

  if (topo) {
    const marcar = () => topo.classList.toggle('rolado', window.scrollY > 8);
    marcar();
    window.addEventListener('scroll', marcar, { passive: true });
  }

  // Link direto para uma pergunta (ex.: /duvidas-comuns/#valores) abre a resposta
  const abrirPergunta = () => {
    if (!location.hash || location.hash.length < 2) return;
    let alvo;
    try { alvo = document.querySelector(location.hash); } catch { return; }
    if (!alvo) return;
    const det = alvo.closest('details') || (alvo.tagName === 'DETAILS' ? alvo : null);
    if (!det) return;
    det.open = true;
    det.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  window.addEventListener('hashchange', abrirPergunta);
  abrirPergunta();
})();
