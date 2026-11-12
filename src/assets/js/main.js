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
    window.matchMedia('(min-width: 1061px)').addEventListener('change', fechar);
  }

  if (topo) {
    const marcar = () => topo.classList.toggle('rolado', window.scrollY > 8);
    marcar();
    window.addEventListener('scroll', marcar, { passive: true });
  }
})();
