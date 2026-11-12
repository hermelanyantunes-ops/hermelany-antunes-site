// Consultar e cancelar agendamento pelo link seguro
import { rpc, esc, fData, fHora, MODALIDADE } from './api.js';

const S = window.SITE;
const box = document.getElementById('gerenciar');
const q = new URLSearchParams(location.search);
const codigo = q.get('c');
const token = q.get('t');

const SITUACAO = { pendente: 'Aguardando confirmação', confirmado: 'Confirmado', cancelado: 'Cancelado', concluido: 'Realizado', faltou: 'Não compareceu' };
const contato = `<a href="mailto:${esc(S.email)}">${esc(S.email)}</a>`;

async function carregar() {
  if (!codigo || !token) {
    box.innerHTML = `<p>Link incompleto. Use o link recebido na confirmação do agendamento ou entre em contato pelo e-mail ${contato}.</p>`;
    return;
  }
  try {
    const b = await rpc('site_get_booking', { p_code: codigo, p_token: token });
    if (!b) { box.innerHTML = `<p>Agendamento não encontrado. Verifique o link ou entre em contato pelo e-mail ${contato}.</p>`; return; }
    render(b);
  } catch (e) {
    box.innerHTML = `<p class="erro-form">${esc(e.message)}</p>`;
  }
}

function render(b, msg = '') {
  box.innerHTML = `
    ${msg}
    <h2>Olá, ${esc(b.first_name)}</h2>
    <dl class="conf-dados">
      <div><dt>Atendimento</dt><dd>${esc(b.service)}</dd></div>
      <div><dt>Data</dt><dd>${esc(fData(b.starts_at))}</dd></div>
      <div><dt>Horário</dt><dd>${fHora(b.starts_at)} às ${fHora(b.ends_at)}</dd></div>
      <div><dt>Modalidade</dt><dd>${esc(MODALIDADE[b.modality])}</dd></div>
      <div><dt>Situação</dt><dd>${esc(SITUACAO[b.status] || b.status)}</dd></div>
      <div><dt>Código</dt><dd class="codigo">${esc(b.code)}</dd></div>
    </dl>
    ${b.can_cancel ? `
      <div class="grupo-botoes">
        <button class="botao botao-secundario" type="button" id="btn-cancelar">Cancelar este agendamento</button>
        <a class="botao botao-primario" href="/agendar/">Escolher outro horário</a>
      </div>
      <div class="erro-form" id="erro" role="alert" hidden></div>
      <p class="nota" style="margin-top:1.25rem">Para remarcar, cancele este horário e escolha um novo na agenda, ou entre em contato.</p>`
      : `<p><a class="botao botao-primario" href="/agendar/">Fazer novo agendamento</a></p>`}`;

  const btn = document.getElementById('btn-cancelar');
  if (btn) btn.addEventListener('click', async () => {
    if (btn.dataset.confirmar !== '1') {
      btn.dataset.confirmar = '1';
      btn.textContent = 'Confirmar cancelamento';
      btn.classList.replace('botao-secundario', 'botao-primario');
      return;
    }
    btn.disabled = true; btn.textContent = 'Cancelando…';
    try {
      await rpc('site_cancel_booking', { p_code: codigo, p_token: token });
      const atualizado = await rpc('site_get_booking', { p_code: codigo, p_token: token });
      render(atualizado, '<p class="conf-selo">Agendamento cancelado</p>');
    } catch (e) {
      const erro = document.getElementById('erro');
      erro.textContent = e.message; erro.hidden = false;
      btn.disabled = false; btn.textContent = 'Confirmar cancelamento';
    }
  });
}

carregar();
