// =====================================================================
// Painel administrativo da agenda
// Acesso: somente contas autorizadas (verificado no banco a cada operação)
// =====================================================================
import { rpc, auth, esc, fData, fDataCurta, fHora, fMes, fDiaSemanaCurto, diaLocal, addDias, diaSemana, isoLocal, MODALIDADE } from './api.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const hoje = () => diaLocal(new Date());

const SIT = { pendente: 'Pendente', confirmado: 'Confirmado', cancelado: 'Cancelado', concluido: 'Realizado', faltou: 'Faltou' };
const TIPO_BLOQ = { bloqueio: 'Bloqueio', ferias: 'Férias', intervalo: 'Intervalo', feriado: 'Feriado', outro: 'Outro' };
const DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

const st = {
  boot: null, aba: 'agenda', vista: 'semana', cursor: hoje(), cancelados: false,
  filtro: { periodo: 'proximos30', status: 'ativos', busca: '' },
};

// ---------------------------------------------------------------------
// Infraestrutura
// ---------------------------------------------------------------------
async function call(fn, args = {}) {
  const t = await auth.token();
  if (!t) { telaEntrar('Sua sessão expirou. Entre novamente.'); throw new Error('Sessão expirada.'); }
  try { return await rpc(fn, args, t); }
  catch (e) {
    if (e.status === 401 || /JWT/i.test(e.message)) { await auth.sair(); telaEntrar('Sua sessão expirou. Entre novamente.'); }
    throw e;
  }
}

async function funcao(rota, corpo = {}) {
  const t = await auth.token();
  const url = st.boot.integration.function_url.replace(/\/$/, '') + rota;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${t}`, apikey: window.SITE.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  } catch { throw new Error('Não foi possível acessar o serviço de integração.'); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Falha na integração.');
  return d;
}

let avisoTimer;
function aviso(msg, erro = false) {
  const a = $('#adm-aviso');
  a.textContent = msg; a.classList.toggle('erro', erro); a.hidden = false;
  clearTimeout(avisoTimer); avisoTimer = setTimeout(() => { a.hidden = true; }, erro ? 6000 : 3200);
}

function mostrar(id) { ['v-entrar', 'v-senha', 'v-painel'].forEach((v) => { $(`#${v}`).hidden = v !== id; }); }

const hm = (iso) => fHora(iso);
const servicoNome = (id) => (st.boot.services.find((s) => s.id === id) || {}).name || 'Todos os tipos';
const telLimpo = (t) => { let d = String(t || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) d = '55' + d; return d; };
const linkWa = (b) => `https://wa.me/${telLimpo(b.phone)}?text=${encodeURIComponent(`Olá, ${b.full_name.split(' ')[0]}! Aqui é a Hermelany Antunes, sobre o seu agendamento de ${fData(b.starts_at)} às ${fHora(b.starts_at)}.`)}`;
const opts = (lista, sel) => lista.map(([v, r]) => `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(r)}</option>`).join('');

// ---------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------
function telaEntrar(msg = '') {
  mostrar('v-entrar');
  const e = $('#e-erro'); e.textContent = msg; e.hidden = !msg;
}

$('#f-entrar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || $('#f-entrar button[type=submit]');
  btn.disabled = true;
  $('#e-erro').hidden = true;
  try {
    await auth.entrar($('#e-email').value.trim(), $('#e-senha').value);
    $('#e-senha').value = '';
    await abrirPainel();
  } catch (e) { telaEntrar(e.message); }
  finally { btn.disabled = false; }
});

$('#b-esqueci').addEventListener('click', async () => {
  const email = $('#e-email').value.trim();
  if (!email) { telaEntrar('Digite seu e-mail no campo acima e clique novamente em "Esqueci minha senha".'); return; }
  try {
    await auth.recuperar(email, `${location.origin}/admin/`);
    telaEntrar('Se o e-mail estiver cadastrado, você receberá um link para definir uma nova senha.');
  } catch (e) { telaEntrar(e.message); }
});

$('#f-senha').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = $('#s-nova').value;
  if (v.length < 8) { $('#s-erro').textContent = 'Use pelo menos 8 caracteres.'; $('#s-erro').hidden = false; return; }
  try { await auth.novaSenha(v); aviso('Senha atualizada.'); await abrirPainel(); }
  catch (e) { $('#s-erro').textContent = e.message; $('#s-erro').hidden = false; }
});

$('#b-sair').addEventListener('click', async () => { await auth.sair(); telaEntrar(); });

async function abrirPainel() {
  let ok;
  try { ok = await call('site_admin_check'); } catch (e) { telaEntrar(e.message); return; }
  if (!ok || !ok.is_admin) { await auth.sair(); telaEntrar('Esta conta não tem acesso ao painel da agenda.'); return; }
  mostrar('v-painel');
  $('#adm-usuario').textContent = (auth.sessao() || {}).email || '';
  await recarregarBoot();
  renderAba();
}

async function recarregarBoot() { st.boot = await call('site_admin_bootstrap'); }

// ---------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------
$$('.adm-abas [role=tab]').forEach((b) => b.addEventListener('click', () => {
  st.aba = b.dataset.aba;
  $$('.adm-abas [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  renderAba();
}));

const conteudo = () => $('#adm-conteudo');
function renderAba() {
  const fn = { agenda: abaAgenda, lista: abaLista, disponibilidade: abaDisponibilidade, bloqueios: abaBloqueios, tipos: abaTipos, config: abaConfig, integracoes: abaIntegracoes }[st.aba];
  fn().catch((e) => { conteudo().innerHTML = `<div class="erro-form">${esc(e.message)}</div>`; });
}

// ---------------------------------------------------------------------
// Agenda (dia, semana, mês)
// ---------------------------------------------------------------------
function periodo() {
  const c = st.cursor;
  if (st.vista === 'dia') return [c, c];
  if (st.vista === 'semana') { const i = addDias(c, -diaSemana(c)); return [i, addDias(i, 6)]; }
  const ini = `${c.slice(0, 7)}-01`;
  const [y, m] = ini.split('-').map(Number);
  const fim = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [addDias(ini, -diaSemana(ini)), addDias(fim, 6 - diaSemana(fim))];
}

async function abaAgenda() {
  const [ini, fim] = periodo();
  const titulo = st.vista === 'dia' ? fData(`${ini}T12:00:00-03:00`)
    : st.vista === 'mes' ? fMes(`${st.cursor}T12:00:00-03:00`)
      : `${fDataCurta(`${ini}T12:00:00-03:00`)} a ${fDataCurta(`${fim}T12:00:00-03:00`)}`;
  conteudo().innerHTML = `
    <div class="adm-barra">
      <div class="grupo">
        <div class="alternador" role="group" aria-label="Visualização">
          ${['dia', 'semana', 'mes'].map((v) => `<button type="button" data-v="${v}" aria-pressed="${st.vista === v}">${{ dia: 'Dia', semana: 'Semana', mes: 'Mês' }[v]}</button>`).join('')}
        </div>
        <button class="cal-seta" data-mov="-1" aria-label="Anterior"><svg viewBox="0 0 20 20" aria-hidden="true" width="18"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>
        <button class="botao botao-secundario botao-pequeno" data-hoje>Hoje</button>
        <button class="cal-seta" data-mov="1" aria-label="Próximo"><svg viewBox="0 0 20 20" aria-hidden="true" width="18"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>
        <p class="cal-titulo">${esc(titulo)}</p>
      </div>
      <div class="grupo">
        <label class="campo-check"><input type="checkbox" id="ck-canc" ${st.cancelados ? 'checked' : ''}> Mostrar cancelados</label>
        <button class="botao botao-secundario botao-pequeno" id="b-bloq">Bloquear horário</button>
        <button class="botao botao-primario botao-pequeno" id="b-novo">Novo agendamento</button>
      </div>
    </div>
    <div id="acal"><p class="carregando">Carregando…</p></div>`;

  $$('[data-v]').forEach((b) => b.addEventListener('click', () => { st.vista = b.dataset.v; abaAgenda(); }));
  $$('[data-mov]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.mov);
    if (st.vista === 'dia') st.cursor = addDias(st.cursor, n);
    else if (st.vista === 'semana') st.cursor = addDias(st.cursor, 7 * n);
    else { const [y, m] = st.cursor.split('-').map(Number); st.cursor = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); }
    abaAgenda();
  }));
  $('[data-hoje]').addEventListener('click', () => { st.cursor = hoje(); abaAgenda(); });
  $('#ck-canc').addEventListener('change', (e) => { st.cancelados = e.target.checked; abaAgenda(); });
  $('#b-novo').addEventListener('click', () => modalAgendamento(null, st.vista === 'dia' ? st.cursor : null));
  $('#b-bloq').addEventListener('click', () => modalBloqueio(null, st.vista === 'dia' ? st.cursor : null));

  const lista = await call('site_admin_bookings', { p_from: isoLocal(ini, '00:00'), p_to: isoLocal(addDias(fim, 1), '00:00') });
  const visiveis = lista.filter((b) => st.cancelados || b.status !== 'cancelado');
  const porDia = {};
  for (const b of visiveis) (porDia[diaLocal(b.starts_at)] ||= []).push(b);
  const bloqueiosDia = (d) => st.boot.blocks.filter((k) => diaLocal(k.starts_at) <= d && diaLocal(new Date(new Date(k.ends_at) - 1)) >= d);

  const evHtml = (b) => `<button type="button" class="ev ${esc(b.status)}" data-id="${esc(b.id)}" title="${esc(`${hm(b.starts_at)} ${b.full_name} — ${b.service} (${MODALIDADE[b.modality]})`)}"><span class="h">${hm(b.starts_at)}</span>${esc(b.full_name)}</button>`;
  const bqHtml = (k) => `<span class="ev bloqueio">${esc(TIPO_BLOQ[k.kind])}${k.reason ? `: ${esc(k.reason)}` : ''}</span>`;
  const alvo = $('#acal');

  if (st.vista === 'mes') {
    const mesAtual = st.cursor.slice(0, 7);
    let h = '<div class="acal-mes">' + ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((d) => `<div class="cab">${d}</div>`).join('');
    for (let d = ini; d <= fim; d = addDias(d, 1)) {
      const bq = bloqueiosDia(d);
      const evs = porDia[d] || [];
      h += `<div class="acal-dia${d.slice(0, 7) !== mesAtual ? ' fora' : ''}${d === hoje() ? ' hoje' : ''}${bq.length ? ' bloq' : ''}" data-dia="${d}">
        <span class="num">${Number(d.slice(8))}</span>
        ${bq.map(bqHtml).join('')}${evs.slice(0, 4).map(evHtml).join('')}${evs.length > 4 ? `<span class="sec">+${evs.length - 4}</span>` : ''}</div>`;
    }
    alvo.innerHTML = h + '</div>';
    $$('.acal-dia', alvo).forEach((c) => c.addEventListener('click', (e) => { if (e.target.closest('.ev')) return; st.cursor = c.dataset.dia; st.vista = 'dia'; abaAgenda(); }));
  } else if (st.vista === 'semana') {
    let h = '<div class="acal-semana">';
    for (let d = ini; d <= fim; d = addDias(d, 1)) {
      const evs = porDia[d] || [];
      h += `<div class="acal-col${d === hoje() ? ' hoje' : ''}"><div class="cab">${fDiaSemanaCurto(`${d}T12:00:00-03:00`)}<strong>${Number(d.slice(8))}</strong></div>
        ${bloqueiosDia(d).map(bqHtml).join('')}
        ${evs.map((b) => `<button type="button" class="ev ${esc(b.status)}" data-id="${esc(b.id)}"><span class="h">${hm(b.starts_at)}–${hm(b.ends_at)}</span><br>${esc(b.full_name)}<br><span class="sec">${esc(b.service)}, ${esc(MODALIDADE[b.modality].toLowerCase())}</span></button>`).join('') || (bloqueiosDia(d).length ? '' : '<p class="sec">Sem agendamentos</p>')}
      </div>`;
    }
    alvo.innerHTML = h + '</div>';
  } else {
    const evs = porDia[ini] || [];
    const bq = bloqueiosDia(ini);
    alvo.innerHTML = `${bq.length ? `<div class="painel">${bq.map((k) => `<p class="adm-sub" style="margin:0">${esc(TIPO_BLOQ[k.kind])}: ${hm(k.starts_at)} às ${hm(k.ends_at)}${k.reason ? `, ${esc(k.reason)}` : ''}</p>`).join('')}</div>` : ''}
      <div class="acal-dia-lista">${evs.length ? evs.map((b) => `
        <div class="acal-item">
          <div class="hora">${hm(b.starts_at)}–${hm(b.ends_at)}</div>
          <div><div class="nome">${esc(b.full_name)} <span class="st st-${esc(b.status)}">${SIT[b.status]}</span></div>
            <div class="det">${esc(b.service)}, ${esc(MODALIDADE[b.modality].toLowerCase())}</div>
            <div class="det">${esc(b.phone)}, ${esc(b.email)}</div>
            ${b.patient_note ? `<div class="det">Obs.: ${esc(b.patient_note)}</div>` : ''}</div>
          <div class="acoes"><a class="btn-txt" href="${linkWa(b)}" target="_blank" rel="noopener">WhatsApp</a><button class="btn-txt" data-id="${esc(b.id)}">Abrir</button></div>
        </div>`).join('') : '<p class="vazio-msg">Nenhum agendamento neste dia.</p>'}</div>`;
  }
  $$('[data-id]', alvo).forEach((b) => b.addEventListener('click', () => modalAgendamento(lista.find((x) => x.id === b.dataset.id))));
}

// ---------------------------------------------------------------------
// Lista de agendamentos
// ---------------------------------------------------------------------
async function abaLista() {
  const f = st.filtro;
  conteudo().innerHTML = `
    <h2>Agendamentos</h2>
    <div class="adm-barra">
      <div class="form-linha" style="flex:1">
        <div class="campo"><label for="fl-p">Período</label><select id="fl-p">${opts([['proximos30', 'Próximos 30 dias'], ['proximos90', 'Próximos 90 dias'], ['ultimos30', 'Últimos 30 dias'], ['ultimos90', 'Últimos 90 dias'], ['ano', 'Últimos 12 meses e próximos 90 dias']], f.periodo)}</select></div>
        <div class="campo"><label for="fl-s">Situação</label><select id="fl-s">${opts([['ativos', 'Pendentes e confirmados'], ['todos', 'Todas'], ...Object.entries(SIT)], f.status)}</select></div>
        <div class="campo"><label for="fl-b">Buscar</label><input id="fl-b" type="search" value="${esc(f.busca)}" placeholder="Nome, e-mail, telefone ou código"></div>
      </div>
      <button class="botao botao-primario botao-pequeno" id="b-novo2">Novo agendamento</button>
    </div>
    <div id="tab-lista"><p class="carregando">Carregando…</p></div>`;
  const recarregar = () => { f.periodo = $('#fl-p').value; f.status = $('#fl-s').value; f.busca = $('#fl-b').value; abaLista(); };
  $('#fl-p').addEventListener('change', recarregar);
  $('#fl-s').addEventListener('change', recarregar);
  $('#fl-b').addEventListener('change', recarregar);
  $('#b-novo2').addEventListener('click', () => modalAgendamento());

  const agora = new Date();
  const dia = 86400000;
  const r = { proximos30: [agora, 30], proximos90: [agora, 90], ultimos30: [new Date(agora - 30 * dia), 30], ultimos90: [new Date(agora - 90 * dia), 90], ano: [new Date(agora - 365 * dia), 455] }[f.periodo];
  let lista = await call('site_admin_bookings', { p_from: r[0].toISOString(), p_to: new Date(+r[0] + r[1] * dia).toISOString() });
  if (f.status === 'ativos') lista = lista.filter((b) => ['pendente', 'confirmado'].includes(b.status));
  else if (f.status !== 'todos') lista = lista.filter((b) => b.status === f.status);
  if (f.busca.trim()) {
    const q = f.busca.trim().toLowerCase();
    lista = lista.filter((b) => [b.full_name, b.email, b.phone, b.code].some((x) => String(x).toLowerCase().includes(q)));
  }
  if (f.periodo.startsWith('ultimos')) lista.reverse();

  $('#tab-lista').innerHTML = lista.length ? `<div class="tabela-envolve"><table class="tabela">
    <thead><tr><th>Data e horário</th><th>Paciente</th><th>Atendimento</th><th>Situação</th><th class="acoes">Ações</th></tr></thead>
    <tbody>${lista.map((b) => `<tr>
      <td>${fDataCurta(b.starts_at)}<span class="sec">${hm(b.starts_at)} às ${hm(b.ends_at)}</span></td>
      <td>${esc(b.full_name)}<span class="sec">${esc(b.phone)}<br>${esc(b.email)}</span></td>
      <td>${esc(b.service)}<span class="sec">${esc(MODALIDADE[b.modality])}, código ${esc(b.code)}${b.source === 'admin' ? ', criado no painel' : ''}</span></td>
      <td><span class="st st-${esc(b.status)}">${SIT[b.status]}</span>${b.sync_error ? `<span class="sec" title="${esc(b.sync_error)}">Falha na sincronização</span>` : ''}</td>
      <td class="acoes">
        ${b.status === 'pendente' ? `<button class="btn-txt" data-acao="confirmado" data-id="${b.id}">Confirmar</button>` : ''}
        ${['pendente', 'confirmado'].includes(b.status) && new Date(b.starts_at) < agora ? `<button class="btn-txt" data-acao="concluido" data-id="${b.id}">Realizado</button><button class="btn-txt" data-acao="faltou" data-id="${b.id}">Faltou</button>` : ''}
        <a class="btn-txt" href="${linkWa(b)}" target="_blank" rel="noopener">WhatsApp</a>
        <button class="btn-txt" data-editar="${b.id}">Editar</button>
        ${['pendente', 'confirmado'].includes(b.status) ? `<button class="btn-txt perigo" data-acao="cancelado" data-id="${b.id}">Cancelar</button>` : ''}
      </td></tr>`).join('')}</tbody></table></div>`
    : '<div class="painel vazio-msg">Nenhum agendamento encontrado com esses filtros.</div>';

  $$('[data-editar]').forEach((b) => b.addEventListener('click', () => modalAgendamento(lista.find((x) => x.id === b.dataset.editar))));
  $$('[data-acao]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.acao === 'cancelado' && !confirm('Cancelar este agendamento? O horário volta a ficar disponível.')) return;
    try { await call('site_admin_set_booking_status', { p_id: b.dataset.id, p_status: b.dataset.acao }); aviso('Situação atualizada.'); abaLista(); }
    catch (e) { aviso(e.message, true); }
  }));
}

// ---------------------------------------------------------------------
// Modal genérico
$('#modal-form').addEventListener('submit', (e) => e.preventDefault());
// ---------------------------------------------------------------------
function modal({ titulo, corpo, salvar, rotSalvar = 'Salvar', extra = '' , aoAbrir }) {
  const dlg = $('#modal');
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').innerHTML = corpo;
  $('#modal-erro').hidden = true;
  $('#modal-rodape').innerHTML = `<div class="grupo">${extra}</div><div class="grupo"><button class="botao botao-secundario botao-pequeno" type="button" data-fechar>Fechar</button><button class="botao botao-primario botao-pequeno" type="button" id="m-salvar">${esc(rotSalvar)}</button></div>`;
  $('#m-salvar').addEventListener('click', async () => {
    const btn = $('#m-salvar'); btn.disabled = true;
    $('#modal-erro').hidden = true;
    try { await salvar($('#modal-corpo')); dlg.close(); }
    catch (e) { $('#modal-erro').textContent = e.message; $('#modal-erro').hidden = false; }
    finally { btn.disabled = false; }
  });
  $$('[data-fechar]', dlg).forEach((b) => { b.onclick = () => dlg.close(); });
  if (aoAbrir) aoAbrir($('#modal-corpo'), $('#modal-rodape'));
  dlg.showModal();
}
const val = (raiz, n) => { const e = raiz.querySelector(`[name="${n}"]`); return e.type === 'checkbox' ? e.checked : e.value.trim(); };

// ---------------------------------------------------------------------
// Agendamento (criar / editar)
// ---------------------------------------------------------------------
function modalAgendamento(b = null, diaPadrao = null) {
  const servs = st.boot.services;
  const dia = b ? diaLocal(b.starts_at) : (diaPadrao || hoje());
  const ini = b ? hm(b.starts_at) : '09:00';
  const fim = b ? hm(b.ends_at) : '';
  modal({
    titulo: b ? `Agendamento ${b.code}` : 'Novo agendamento',
    corpo: `
      <div class="form-linha">
        <div class="campo"><label>Tipo de atendimento</label><select name="service_type_id" required>${opts(servs.filter((s) => s.active || (b && s.id === b.service_type_id)).map((s) => [s.id, s.name]), b ? b.service_type_id : servs[0] && servs[0].id)}</select></div>
        <div class="campo"><label>Modalidade</label><select name="modality">${opts([['presencial', 'Presencial'], ['online', 'Online']], b ? b.modality : 'presencial')}</select></div>
      </div>
      <div class="form-linha">
        <div class="campo"><label>Data</label><input type="date" name="dia" value="${dia}" required></div>
        <div class="campo"><label>Início</label><input type="time" name="ini" value="${ini}" required step="300"></div>
        <div class="campo"><label>Término</label><input type="time" name="fim" value="${fim}" step="300"></div>
        <div class="campo"><label>Situação</label><select name="status">${opts(Object.entries(SIT), b ? b.status : 'confirmado')}</select></div>
      </div>
      <div class="campo"><label>Nome completo</label><input name="full_name" value="${esc(b ? b.full_name : '')}" required></div>
      <div class="form-linha">
        <div class="campo"><label>E-mail</label><input type="email" name="email" value="${esc(b ? b.email : '')}" required></div>
        <div class="campo"><label>Telefone / WhatsApp</label><input type="tel" name="phone" value="${esc(b ? b.phone : '')}" required></div>
      </div>
      <div class="campo"><label>Observação do paciente</label><textarea name="patient_note" rows="2" maxlength="400">${esc(b ? b.patient_note || '' : '')}</textarea></div>
      <div class="campo"><label>Anotação administrativa</label><textarea name="internal_note" rows="2" maxlength="600">${esc(b ? b.internal_note || '' : '')}</textarea>
        <p class="ajuda">Somente informações administrativas. Não registre dados clínicos aqui.</p></div>
      ${b ? `<p class="ajuda">Criado em ${fDataCurta(b.created_at)} ${b.source === 'admin' ? 'pelo painel' : 'pelo site'}.${b.gcal_event_id ? ' Sincronizado com o Google Agenda.' : ''}${b.email_sent_at ? ' Confirmação enviada por e-mail.' : ''}${b.sync_error ? ` Erro de sincronização: ${esc(b.sync_error)}` : ''}</p>` : ''}`,
    extra: b ? `<a class="botao botao-secundario botao-pequeno" href="${linkWa(b)}" target="_blank" rel="noopener">WhatsApp do paciente</a>` : '',
    aoAbrir: (raiz) => {
      const ajustarFim = () => {
        const s = servs.find((x) => x.id === val(raiz, 'service_type_id'));
        const [h, m] = val(raiz, 'ini').split(':').map(Number);
        if (!s || Number.isNaN(h)) return;
        const t = h * 60 + m + s.duration_min;
        raiz.querySelector('[name=fim]').value = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      };
      raiz.querySelector('[name=service_type_id]').addEventListener('change', ajustarFim);
      raiz.querySelector('[name=ini]').addEventListener('change', ajustarFim);
      if (!b) ajustarFim();
    },
    salvar: async (raiz) => {
      const d = val(raiz, 'dia');
      const p = {
        id: b ? b.id : '', service_type_id: val(raiz, 'service_type_id'), modality: val(raiz, 'modality'),
        starts_at: isoLocal(d, val(raiz, 'ini')), ends_at: val(raiz, 'fim') ? isoLocal(d, val(raiz, 'fim')) : '',
        status: val(raiz, 'status'), full_name: val(raiz, 'full_name'), email: val(raiz, 'email'), phone: val(raiz, 'phone'),
        patient_note: val(raiz, 'patient_note'), internal_note: val(raiz, 'internal_note'),
      };
      if (!d || !val(raiz, 'ini')) throw new Error('Informe data e horário de início.');
      await call('site_admin_save_booking', { p });
      aviso(b ? 'Agendamento atualizado.' : 'Agendamento criado.');
      renderAba();
    },
  });
}

// ---------------------------------------------------------------------
// Disponibilidade
// ---------------------------------------------------------------------
async function abaDisponibilidade() {
  const regras = st.boot.rules;
  const extras = st.boot.extras.filter((e) => new Date(e.ends_at) > new Date());
  const chip = (r) => `<span class="chip${r.active ? '' : ' inativo'}">${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}, ${esc(MODALIDADE[r.modality].toLowerCase())}${r.service_type_id ? `, ${esc(servicoNome(r.service_type_id))}` : ''}${r.valid_from || r.valid_until ? ` (${r.valid_from ? `de ${fDataCurta(`${r.valid_from}T12:00:00-03:00`)}` : ''}${r.valid_until ? ` até ${fDataCurta(`${r.valid_until}T12:00:00-03:00`)}` : ''})` : ''}
    <button data-er="${r.id}">editar</button><button data-xr="${r.id}">excluir</button></span>`;
  conteudo().innerHTML = `
    <div class="adm-barra"><div><h2>Horários de trabalho</h2><p class="adm-sub">Disponibilidade semanal recorrente. Para criar um intervalo (por exemplo, almoço), cadastre dois períodos no mesmo dia. O intervalo entre atendimentos e a antecedência mínima ficam em Configurações.</p></div>
      <button class="botao botao-primario botao-pequeno" id="b-regra">Adicionar período</button></div>
    <div class="dias-semana">${[1, 2, 3, 4, 5, 6, 0].map((d) => {
      const rs = regras.filter((r) => r.weekday === d);
      return `<div class="dia-regra"><span class="nome-dia">${DIAS[d]}</span><div class="chips">${rs.length ? rs.map(chip).join('') : '<span class="sec">Sem atendimento</span>'}</div></div>`;
    }).join('')}</div>

    <div class="adm-barra" style="margin-top:2.5rem"><div><h2>Horários avulsos liberados</h2><p class="adm-sub">Libere horários fora da rotina semanal, em datas específicas.</p></div>
      <button class="botao botao-secundario botao-pequeno" id="b-extra">Liberar horário avulso</button></div>
    ${extras.length ? `<div class="tabela-envolve"><table class="tabela"><thead><tr><th>Data</th><th>Horário</th><th>Modalidade</th><th>Tipo</th><th>Nota</th><th class="acoes">Ações</th></tr></thead><tbody>
      ${extras.map((e) => `<tr><td>${fDataCurta(e.starts_at)}</td><td>${hm(e.starts_at)} às ${hm(e.ends_at)}</td><td>${esc(MODALIDADE[e.modality])}</td><td>${esc(servicoNome(e.service_type_id))}</td><td>${esc(e.note || '')}</td>
      <td class="acoes"><button class="btn-txt" data-ee="${e.id}">Editar</button><button class="btn-txt perigo" data-xe="${e.id}">Excluir</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="painel vazio-msg">Nenhum horário avulso liberado.</div>'}`;

  $('#b-regra').addEventListener('click', () => modalRegra());
  $('#b-extra').addEventListener('click', () => modalExtra());
  $$('[data-er]').forEach((b) => b.addEventListener('click', () => modalRegra(regras.find((r) => r.id === b.dataset.er))));
  $$('[data-xr]').forEach((b) => b.addEventListener('click', () => excluir('rule', b.dataset.xr, 'Excluir este período de atendimento?')));
  $$('[data-ee]').forEach((b) => b.addEventListener('click', () => modalExtra(extras.find((r) => r.id === b.dataset.ee))));
  $$('[data-xe]').forEach((b) => b.addEventListener('click', () => excluir('extra', b.dataset.xe, 'Excluir este horário avulso?')));
}

async function excluir(entidade, id, pergunta) {
  if (!confirm(pergunta)) return;
  try { await call('site_admin_delete', { p_entity: entidade, p_id: id }); await recarregarBoot(); aviso('Excluído.'); renderAba(); }
  catch (e) { aviso(e.message, true); }
}

const optsServicos = (sel) => opts([['', 'Todos os tipos'], ...st.boot.services.filter((s) => s.active).map((s) => [s.id, s.name])], sel || '');
const optsModalidade = (sel, ambas = true) => opts([...(ambas ? [['ambas', 'Presencial e online']] : []), ['presencial', 'Somente presencial'], ['online', 'Somente online']], sel);

function modalRegra(r = null) {
  modal({
    titulo: r ? 'Editar período' : 'Adicionar período semanal',
    corpo: `
      ${r ? `<div class="campo"><label>Dia da semana</label><select name="weekday">${opts(DIAS.map((d, i) => [i, d]), r.weekday)}</select></div>`
        : `<fieldset class="campo"><label>Dias da semana</label><div class="chips">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label class="campo-check"><input type="checkbox" name="d${i}"> ${DIAS[i].split('-')[0]}</label>`).join('')}</div></fieldset>`}
      <div class="form-linha">
        <div class="campo"><label>Início</label><input type="time" name="start_time" value="${r ? r.start_time.slice(0, 5) : '08:00'}" step="300"></div>
        <div class="campo"><label>Fim</label><input type="time" name="end_time" value="${r ? r.end_time.slice(0, 5) : '12:00'}" step="300"></div>
        <div class="campo"><label>Modalidade</label><select name="modality">${optsModalidade(r ? r.modality : 'ambas')}</select></div>
      </div>
      <div class="campo"><label>Tipo de atendimento</label><select name="service_type_id">${optsServicos(r && r.service_type_id)}</select></div>
      <div class="form-linha">
        <div class="campo"><label>Válido a partir de (opcional)</label><input type="date" name="valid_from" value="${r && r.valid_from ? r.valid_from : ''}"></div>
        <div class="campo"><label>Válido até (opcional)</label><input type="date" name="valid_until" value="${r && r.valid_until ? r.valid_until : ''}"></div>
      </div>
      <div class="campo"><label>Nota interna (opcional)</label><input name="note" value="${esc(r ? r.note || '' : '')}" maxlength="200"></div>
      <label class="campo-check"><input type="checkbox" name="active" ${!r || r.active ? 'checked' : ''}> Ativo</label>`,
    salvar: async (raiz) => {
      const base = { start_time: val(raiz, 'start_time'), end_time: val(raiz, 'end_time'), modality: val(raiz, 'modality'), service_type_id: val(raiz, 'service_type_id'), valid_from: val(raiz, 'valid_from'), valid_until: val(raiz, 'valid_until'), note: val(raiz, 'note'), active: val(raiz, 'active') };
      if (base.end_time <= base.start_time) throw new Error('O horário de fim deve ser posterior ao início.');
      if (r) await call('site_admin_save', { p_entity: 'rule', p: { ...base, id: r.id, weekday: Number(val(raiz, 'weekday')) } });
      else {
        const dias = [0, 1, 2, 3, 4, 5, 6].filter((i) => val(raiz, `d${i}`));
        if (!dias.length) throw new Error('Selecione pelo menos um dia da semana.');
        for (const d of dias) await call('site_admin_save', { p_entity: 'rule', p: { ...base, weekday: d } });
      }
      await recarregarBoot(); aviso('Disponibilidade salva.'); renderAba();
    },
  });
}

function modalExtra(e = null) {
  modal({
    titulo: e ? 'Editar horário avulso' : 'Liberar horário avulso',
    corpo: `
      <div class="form-linha">
        <div class="campo"><label>Data</label><input type="date" name="dia" value="${e ? diaLocal(e.starts_at) : hoje()}"></div>
        <div class="campo"><label>Início</label><input type="time" name="ini" value="${e ? hm(e.starts_at) : '18:00'}" step="300"></div>
        <div class="campo"><label>Fim</label><input type="time" name="fim" value="${e ? hm(e.ends_at) : '20:00'}" step="300"></div>
      </div>
      <div class="form-linha">
        <div class="campo"><label>Modalidade</label><select name="modality">${optsModalidade(e ? e.modality : 'ambas')}</select></div>
        <div class="campo"><label>Tipo de atendimento</label><select name="service_type_id">${optsServicos(e && e.service_type_id)}</select></div>
      </div>
      <div class="campo"><label>Nota interna (opcional)</label><input name="note" value="${esc(e ? e.note || '' : '')}" maxlength="200"></div>`,
    salvar: async (raiz) => {
      const d = val(raiz, 'dia');
      if (val(raiz, 'fim') <= val(raiz, 'ini')) throw new Error('O horário de fim deve ser posterior ao início.');
      await call('site_admin_save', { p_entity: 'extra', p: { id: e ? e.id : '', starts_at: isoLocal(d, val(raiz, 'ini')), ends_at: isoLocal(d, val(raiz, 'fim')), modality: val(raiz, 'modality'), service_type_id: val(raiz, 'service_type_id'), note: val(raiz, 'note') } });
      await recarregarBoot(); aviso('Horário liberado.'); renderAba();
    },
  });
}

// ---------------------------------------------------------------------
// Bloqueios e férias
// ---------------------------------------------------------------------
async function abaBloqueios() {
  const lista = st.boot.blocks;
  conteudo().innerHTML = `
    <div class="adm-barra"><div><h2>Bloqueios, intervalos e férias</h2><p class="adm-sub">Períodos bloqueados deixam de aparecer na agenda pública. Agendamentos já existentes nesses períodos não são cancelados automaticamente.</p></div>
      <div class="grupo"><button class="botao botao-secundario botao-pequeno" id="b-ferias">Registrar férias</button><button class="botao botao-primario botao-pequeno" id="b-bloq2">Bloquear horário</button></div></div>
    ${lista.length ? `<div class="tabela-envolve"><table class="tabela"><thead><tr><th>Tipo</th><th>Início</th><th>Fim</th><th>Modalidade</th><th>Motivo</th><th class="acoes">Ações</th></tr></thead><tbody>
      ${lista.map((k) => `<tr><td>${esc(TIPO_BLOQ[k.kind])}</td><td>${fDataCurta(k.starts_at)} ${hm(k.starts_at)}</td><td>${fDataCurta(k.ends_at)} ${hm(k.ends_at)}</td><td>${k.modality ? esc(MODALIDADE[k.modality]) : 'Ambas'}</td><td>${esc(k.reason || '')}</td>
      <td class="acoes"><button class="btn-txt" data-eb="${k.id}">Editar</button><button class="btn-txt perigo" data-xb="${k.id}">Excluir</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="painel vazio-msg">Nenhum bloqueio cadastrado.</div>'}`;
  $('#b-bloq2').addEventListener('click', () => modalBloqueio());
  $('#b-ferias').addEventListener('click', () => modalBloqueio({ kind: 'ferias', _novo: true }));
  $$('[data-eb]').forEach((b) => b.addEventListener('click', () => modalBloqueio(lista.find((k) => k.id === b.dataset.eb))));
  $$('[data-xb]').forEach((b) => b.addEventListener('click', () => excluir('block', b.dataset.xb, 'Excluir este bloqueio? Os horários voltarão a ficar disponíveis.')));
}

function modalBloqueio(k = null, diaPadrao = null) {
  const novo = !k || k._novo;
  const ferias = k && k.kind === 'ferias';
  const d1 = !novo ? diaLocal(k.starts_at) : (diaPadrao || hoje());
  const d2 = !novo ? diaLocal(new Date(new Date(k.ends_at) - 60000)) : d1;
  const diaInteiro = novo ? ferias : (hm(k.starts_at) === '00:00' && hm(k.ends_at) === '00:00');
  modal({
    titulo: novo ? (ferias ? 'Registrar férias' : 'Bloquear horário') : 'Editar bloqueio',
    corpo: `
      <div class="form-linha">
        <div class="campo"><label>Tipo</label><select name="kind">${opts(Object.entries(TIPO_BLOQ), k ? k.kind : 'bloqueio')}</select></div>
        <div class="campo"><label>Modalidade afetada</label><select name="modality">${opts([['', 'Ambas'], ['presencial', 'Somente presencial'], ['online', 'Somente online']], k ? k.modality || '' : '')}</select></div>
      </div>
      <label class="campo-check"><input type="checkbox" name="inteiro" ${diaInteiro ? 'checked' : ''}> Dia(s) inteiro(s)</label>
      <div class="form-linha">
        <div class="campo"><label>Data inicial</label><input type="date" name="d1" value="${d1}"></div>
        <div class="campo hora-bq"><label>Hora inicial</label><input type="time" name="h1" value="${!novo ? hm(k.starts_at) : '12:00'}" step="300"></div>
        <div class="campo"><label>Data final</label><input type="date" name="d2" value="${d2}"></div>
        <div class="campo hora-bq"><label>Hora final</label><input type="time" name="h2" value="${!novo ? hm(k.ends_at) : '14:00'}" step="300"></div>
      </div>
      <div class="campo"><label>Motivo (opcional, uso interno)</label><input name="reason" value="${esc(k && !novo ? k.reason || '' : '')}" maxlength="200"></div>`,
    aoAbrir: (raiz) => {
      const ajustar = () => $$('.hora-bq', raiz).forEach((c) => { c.hidden = val(raiz, 'inteiro'); });
      raiz.querySelector('[name=inteiro]').addEventListener('change', ajustar); ajustar();
    },
    salvar: async (raiz) => {
      const inteiro = val(raiz, 'inteiro');
      const ini = isoLocal(val(raiz, 'd1'), inteiro ? '00:00' : val(raiz, 'h1'));
      const fim = inteiro ? isoLocal(addDias(val(raiz, 'd2'), 1), '00:00') : isoLocal(val(raiz, 'd2'), val(raiz, 'h2'));
      if (new Date(fim) <= new Date(ini)) throw new Error('O fim deve ser posterior ao início.');
      await call('site_admin_save', { p_entity: 'block', p: { id: !novo ? k.id : '', starts_at: ini, ends_at: fim, kind: val(raiz, 'kind'), modality: val(raiz, 'modality'), reason: val(raiz, 'reason') } });
      await recarregarBoot();
      const conflitos = (await call('site_admin_bookings', { p_from: ini, p_to: fim })).filter((b) => ['pendente', 'confirmado'].includes(b.status));
      aviso(conflitos.length ? `Bloqueio salvo. Atenção: ${conflitos.length} agendamento(s) já marcado(s) nesse período.` : 'Bloqueio salvo.', conflitos.length > 0);
      renderAba();
    },
  });
}

// ---------------------------------------------------------------------
// Tipos de atendimento
// ---------------------------------------------------------------------
async function abaTipos() {
  const servs = st.boot.services;
  conteudo().innerHTML = `
    <div class="adm-barra"><div><h2>Tipos de atendimento</h2><p class="adm-sub">Defina a duração de cada tipo, as modalidades permitidas e se ele aparece na agenda pública. Para a avaliação neuropsicológica, a duração vale para cada sessão; o número de sessões é combinado individualmente.</p></div>
      <button class="botao botao-primario botao-pequeno" id="b-tipo">Novo tipo</button></div>
    <div class="tabela-envolve"><table class="tabela"><thead><tr><th>Nome</th><th>Duração</th><th>Modalidades</th><th>Agenda pública</th><th>Situação</th><th class="acoes">Ações</th></tr></thead><tbody>
    ${servs.map((s) => `<tr><td>${esc(s.name)}<span class="sec">${esc(s.description || '')}</span></td><td>${s.duration_min} min</td>
      <td>${[s.allow_presencial && 'Presencial', s.allow_online && 'Online'].filter(Boolean).join(' e ') || 'Nenhuma'}</td>
      <td>${s.public_booking ? 'Sim' : 'Somente pelo painel'}</td><td>${s.active ? 'Ativo' : 'Inativo'}</td>
      <td class="acoes"><button class="btn-txt" data-et="${s.id}">Editar</button><button class="btn-txt perigo" data-xt="${s.id}">Excluir</button></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#b-tipo').addEventListener('click', () => modalTipo());
  $$('[data-et]').forEach((b) => b.addEventListener('click', () => modalTipo(servs.find((s) => s.id === b.dataset.et))));
  $$('[data-xt]').forEach((b) => b.addEventListener('click', () => excluir('service_type', b.dataset.xt, 'Excluir este tipo? Se já houver agendamentos com ele, ele será apenas desativado.')));
}

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function modalTipo(s = null) {
  modal({
    titulo: s ? 'Editar tipo de atendimento' : 'Novo tipo de atendimento',
    corpo: `
      <div class="campo"><label>Nome</label><input name="name" value="${esc(s ? s.name : '')}" maxlength="120"></div>
      <div class="campo"><label>Descrição exibida na agenda</label><textarea name="description" rows="2" maxlength="600">${esc(s ? s.description || '' : '')}</textarea></div>
      <div class="form-linha">
        <div class="campo"><label>Duração (minutos)</label><input type="number" name="duration_min" min="10" max="600" step="5" value="${s ? s.duration_min : 50}"></div>
        <div class="campo"><label>Ordem de exibição</label><input type="number" name="sort_order" value="${s ? s.sort_order : st.boot.services.length + 1}"></div>
      </div>
      <label class="campo-check"><input type="checkbox" name="allow_presencial" ${!s || s.allow_presencial ? 'checked' : ''}> Permite presencial</label>
      <label class="campo-check"><input type="checkbox" name="allow_online" ${!s || s.allow_online ? 'checked' : ''}> Permite online</label>
      <label class="campo-check"><input type="checkbox" name="public_booking" ${!s || s.public_booking ? 'checked' : ''}> Disponível na agenda pública</label>
      <label class="campo-check"><input type="checkbox" name="active" ${!s || s.active ? 'checked' : ''}> Ativo</label>`,
    salvar: async (raiz) => {
      const nome = val(raiz, 'name');
      if (nome.length < 2) throw new Error('Informe o nome.');
      await call('site_admin_save', { p_entity: 'service_type', p: {
        id: s ? s.id : '', slug: s ? s.slug : slugify(nome), name: nome, description: val(raiz, 'description'),
        duration_min: Number(val(raiz, 'duration_min')), sort_order: Number(val(raiz, 'sort_order')),
        allow_presencial: val(raiz, 'allow_presencial'), allow_online: val(raiz, 'allow_online'),
        public_booking: val(raiz, 'public_booking'), active: val(raiz, 'active') } });
      await recarregarBoot(); aviso('Tipo de atendimento salvo.'); renderAba();
    },
  });
}

// ---------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------
async function abaConfig() {
  const c = st.boot.settings;
  conteudo().innerHTML = `
    <h2>Configurações da agenda</h2>
    <div class="adm-grade-2">
      <form class="painel" id="f-config">
        <h3>Regras de agendamento</h3>
        <div class="form-linha">
          <div class="campo"><label>Intervalo entre opções de horário (min)</label><input type="number" name="slot_step_min" min="5" max="240" step="5" value="${c.slot_step_min}"></div>
          <div class="campo"><label>Intervalo entre atendimentos (min)</label><input type="number" name="buffer_min" min="0" max="120" step="5" value="${c.buffer_min}"></div>
        </div>
        <div class="form-linha">
          <div class="campo"><label>Antecedência mínima (horas)</label><input type="number" name="min_notice_hours" min="0" max="720" value="${c.min_notice_hours}"></div>
          <div class="campo"><label>Agenda aberta até (dias)</label><input type="number" name="max_days_ahead" min="1" max="365" value="${c.max_days_ahead}"></div>
          <div class="campo"><label>Agendamentos ativos por e-mail</label><input type="number" name="max_active_per_email" min="1" max="20" value="${c.max_active_per_email}"></div>
        </div>
        <label class="campo-check" style="margin:1rem 0"><input type="checkbox" name="auto_confirm" ${c.auto_confirm ? 'checked' : ''}> Confirmar automaticamente os agendamentos feitos pelo site</label>
        <p class="ajuda">Desmarcado, os novos agendamentos ficam "pendentes" (o horário fica reservado) até você confirmar na aba Agendamentos.</p>
        <h3>Orientações exibidas na confirmação</h3>
        <div class="campo"><label>Atendimento presencial</label><textarea name="instructions_presencial" rows="3">${esc(c.instructions_presencial || '')}</textarea></div>
        <div class="campo"><label>Atendimento online</label><textarea name="instructions_online" rows="3">${esc(c.instructions_online || '')}</textarea></div>
        <button class="botao botao-primario botao-pequeno" type="submit" style="margin-top:1rem">Salvar configurações</button>
      </form>
      <div>
        <div class="painel">
          <h3>Pessoas autorizadas no painel</h3>
          <p class="ajuda">A pessoa precisa ter uma conta com esse e-mail no sistema para entrar.</p>
          <ul class="chips" id="lista-admins" style="list-style:none;padding:0;margin:.75rem 0">${st.boot.admins.map((e) => `<li class="chip">${esc(e)}${e !== 'hermelanyantunes@gmail.com' ? `<button data-rm="${esc(e)}">remover</button>` : ''}</li>`).join('')}</ul>
          <form class="form-linha" id="f-admin"><div class="campo"><label>Adicionar e-mail</label><input type="email" name="email" required></div><button class="botao botao-secundario botao-pequeno" type="submit">Autorizar</button></form>
        </div>
        <div class="painel">
          <h3>Privacidade (LGPD)</h3>
          <p class="ajuda">Anonimiza nome, e-mail, telefone e observações de agendamentos antigos, mantendo apenas datas e tipos para estatística.</p>
          <form class="form-linha" id="f-anon"><div class="campo"><label>Agendamentos encerrados há mais de (meses)</label><input type="number" name="meses" min="1" value="24"></div><button class="botao botao-secundario botao-pequeno" type="submit">Anonimizar</button></form>
        </div>
      </div>
    </div>`;

  $('#f-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const p = {};
    for (const n of ['slot_step_min', 'buffer_min', 'min_notice_hours', 'max_days_ahead', 'max_active_per_email']) p[n] = Number(f[n].value);
    p.auto_confirm = f.auto_confirm.checked; p.instructions_presencial = f.instructions_presencial.value; p.instructions_online = f.instructions_online.value;
    try { await call('site_admin_save', { p_entity: 'settings', p }); await recarregarBoot(); aviso('Configurações salvas.'); }
    catch (err) { aviso(err.message, true); }
  });
  $('#f-admin').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await call('site_admin_admins', { p_action: 'add', p_email: e.target.email.value }); await recarregarBoot(); aviso('Acesso autorizado.'); renderAba(); }
    catch (err) { aviso(err.message, true); }
  });
  $$('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Remover o acesso de ${b.dataset.rm}?`)) return;
    try { await call('site_admin_admins', { p_action: 'remove', p_email: b.dataset.rm }); await recarregarBoot(); aviso('Acesso removido.'); renderAba(); }
    catch (err) { aviso(err.message, true); }
  }));
  $('#f-anon').addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = Number(e.target.meses.value);
    if (!confirm(`Anonimizar definitivamente os agendamentos encerrados há mais de ${m} meses? Esta ação não pode ser desfeita.`)) return;
    try { const r = await call('site_admin_anonymize', { p_months: m }); aviso(`${r.anonymized} agendamento(s) anonimizado(s).`); }
    catch (err) { aviso(err.message, true); }
  });
}

// ---------------------------------------------------------------------
// Integrações (Google Agenda + e-mail)
// ---------------------------------------------------------------------
async function abaIntegracoes() {
  const i = st.boot.integration;
  const callback = `${i.function_url.replace(/\/$/, '')}/callback`;
  conteudo().innerHTML = `
    <h2>Google Agenda e e-mail de confirmação</h2>
    <p class="adm-sub">Com a integração ativa, cada agendamento confirmado aparece no seu Google Agenda, alterações e cancelamentos são sincronizados, os compromissos ocupados do seu Google Agenda deixam de aparecer como disponíveis no site e o paciente recebe a confirmação por e-mail, enviada pela sua conta Gmail.</p>
    <div class="adm-grade-2">
      <div class="painel">
        <h3>Situação</h3>
        <p><span class="estado-int ${i.google_connected ? 'ok' : ''}">${i.google_connected ? `Conectado${i.google_email ? ` a ${esc(i.google_email)}` : ''}` : 'Não conectado'}</span></p>
        ${i.last_sync_at ? `<p class="ajuda">Última sincronização: ${fDataCurta(i.last_sync_at)} às ${hm(i.last_sync_at)}.</p>` : ''}
        ${i.last_sync_error ? `<p class="erro-form">${esc(i.last_sync_error)}</p>` : ''}
        <div class="grupo-botoes" style="margin-top:1rem">
          <button class="botao botao-primario botao-pequeno" id="b-conectar" ${i.google_client_id && i.google_client_secret_set ? '' : 'disabled'}>${i.google_connected ? 'Reconectar' : 'Conectar Google Agenda'}</button>
          ${i.google_connected ? '<button class="botao botao-secundario botao-pequeno" id="b-sinc">Sincronizar agora</button><button class="botao botao-secundario botao-pequeno" id="b-desc">Desconectar</button>' : ''}
        </div>
        ${i.google_client_id && i.google_client_secret_set ? '' : '<p class="ajuda">Cadastre as credenciais ao lado para habilitar a conexão.</p>'}
        <form id="f-int" style="margin-top:1.5rem">
          <h3>Preferências</h3>
          <label class="campo-check"><input type="checkbox" name="send_emails" ${i.send_emails ? 'checked' : ''}> Enviar e-mail de confirmação e cancelamento ao paciente</label>
          <div class="form-linha" style="margin-top:.75rem">
            <div class="campo"><label>Agenda do Google</label><input name="google_calendar_id" value="${esc(i.google_calendar_id)}"><p class="ajuda">"primary" é a agenda principal da conta.</p></div>
            <div class="campo"><label>Endereço do site</label><input name="site_url" value="${esc(i.site_url)}"><p class="ajuda">Usado nos links dos e-mails.</p></div>
          </div>
          <button class="botao botao-secundario botao-pequeno" type="submit">Salvar preferências</button>
        </form>
      </div>
      <div class="painel">
        <h3>Como configurar (uma única vez)</h3>
        <ol class="passos-google">
          <li>Acesse <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> com hermelanyantunes@gmail.com e crie um projeto (por exemplo, "Agenda do site").</li>
          <li>Em "APIs e serviços", ative a <strong>Google Calendar API</strong> e a <strong>Gmail API</strong>.</li>
          <li>Em "Tela de consentimento OAuth" (Google Auth Platform), escolha o tipo <strong>Externo</strong>, preencha o nome do app e seu e-mail. Em "Público", clique em <strong>Publicar app</strong> (assim a conexão não expira a cada 7 dias).</li>
          <li>Em "Credenciais" (ou "Clientes"), crie um <strong>ID do cliente OAuth</strong> do tipo <strong>Aplicativo da Web</strong> e adicione este URI de redirecionamento autorizado:
            <div class="copiavel"><span id="uri-cb">${esc(callback)}</span></div>
            <button class="btn-txt" type="button" id="b-copiar">Copiar endereço</button></li>
          <li>Copie o ID do cliente e a chave secreta e cole abaixo.</li>
          <li>Clique em "Conectar Google Agenda" e autorize com sua conta. Como o app é seu e não passou pela verificação do Google, ele exibirá um aviso: clique em "Avançado" e em "Acessar".</li>
        </ol>
        <form id="f-cred">
          <div class="campo"><label>ID do cliente</label><input name="cid" value="${esc(i.google_client_id || '')}" placeholder="…apps.googleusercontent.com" autocomplete="off"></div>
          <div class="campo" style="margin-top:.75rem"><label>Chave secreta do cliente</label><input name="csec" type="password" placeholder="${i.google_client_secret_set ? 'Já cadastrada. Preencha somente para trocar.' : ''}" autocomplete="off"></div>
          <p class="ajuda">A chave secreta é guardada de forma criptografada e não pode ser lida pelo site.</p>
          <button class="botao botao-secundario botao-pequeno" type="submit">Salvar credenciais</button>
        </form>
      </div>
    </div>`;

  $('#b-copiar').addEventListener('click', async () => { try { await navigator.clipboard.writeText(callback); aviso('Endereço copiado.'); } catch { aviso('Selecione e copie o endereço manualmente.', true); } });
  $('#f-cred').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await call('site_admin_set_google_client', { p_client_id: e.target.cid.value, p_client_secret: e.target.csec.value }); await recarregarBoot(); aviso('Credenciais salvas.'); renderAba(); }
    catch (err) { aviso(err.message, true); }
  });
  $('#f-int').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await call('site_admin_save', { p_entity: 'integration', p: { send_emails: e.target.send_emails.checked, google_calendar_id: e.target.google_calendar_id.value, site_url: e.target.site_url.value } }); await recarregarBoot(); aviso('Preferências salvas.'); }
    catch (err) { aviso(err.message, true); }
  });
  const conectar = $('#b-conectar');
  if (conectar) conectar.addEventListener('click', async () => {
    conectar.disabled = true;
    try { const r = await funcao('/start', { return_to: `${location.origin}/admin/` }); location.href = r.url; }
    catch (err) { aviso(err.message, true); conectar.disabled = false; }
  });
  const sinc = $('#b-sinc');
  if (sinc) sinc.addEventListener('click', async () => {
    sinc.disabled = true;
    try { const r = await funcao('/sync-all'); await recarregarBoot(); aviso(`Sincronizado: ${r.busy ?? 0} compromissos ocupados lidos, ${r.bookings ?? 0} agendamentos atualizados.`); renderAba(); }
    catch (err) { aviso(err.message, true); sinc.disabled = false; }
  });
  const desc = $('#b-desc');
  if (desc) desc.addEventListener('click', async () => {
    if (!confirm('Desconectar o Google Agenda? Os eventos já criados permanecem na sua agenda.')) return;
    try { await funcao('/disconnect'); await recarregarBoot(); aviso('Google Agenda desconectado.'); renderAba(); }
    catch (err) { aviso(err.message, true); }
  });
}

// ---------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------
(async function iniciar() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('access_token')) {
    auth.definirSessao(Object.fromEntries(hash));
    history.replaceState(null, '', location.pathname);
    if (hash.get('type') === 'recovery') { mostrar('v-senha'); return; }
  }
  if (hash.get('error_description')) { history.replaceState(null, '', location.pathname); telaEntrar(hash.get('error_description')); return; }

  const q = new URLSearchParams(location.search);
  if (q.get('google')) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => aviso(q.get('google') === 'ok' ? 'Google Agenda conectado.' : `Não foi possível conectar: ${q.get('motivo') || 'tente novamente.'}`, q.get('google') !== 'ok'), 600);
    st.aba = 'integracoes';
    $$('.adm-abas [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.aba === 'integracoes')));
  }
  if (await auth.token()) await abrirPainel();
  else telaEntrar();
})();
