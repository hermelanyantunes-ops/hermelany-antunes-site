// Agenda online — área pública
import { rpc, esc, fData, fHora, fMes, fDiaSemanaCurto, diaLocal, addDias, diaSemana, MODALIDADE } from './api.js';

const S = window.SITE;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const app = $('#agenda-app');
const form = $('#agenda-form');
const el = {
  tipos: $('#lista-tipos'),
  passoMod: $('#passo-modalidade'), passoData: $('#passo-data'), passoDados: $('#passo-dados'),
  calTitulo: $('#cal-titulo'), calCorpo: $('#cal-corpo'), ant: $('#cal-ant'), prox: $('#cal-prox'),
  horarios: $('#horarios'), erro: $('#erro-form'), enviar: $('#btn-enviar'), conf: $('#confirmacao'),
  r: { tipo: $('#r-tipo'), mod: $('#r-modalidade'), data: $('#r-data'), hora: $('#r-hora') },
};

const estado = {
  config: null, servico: null, modalidade: null,
  vista: window.matchMedia('(max-width: 720px)').matches ? 'semana' : 'mes',
  cursor: null, dia: null, slot: null, slots: new Map(), enviando: false,
};
const hoje = diaLocal(new Date());

// ---------------------------------------------------------------------
async function iniciar() {
  try {
    estado.config = await rpc('site_get_public_config');
  } catch (e) {
    el.tipos.innerHTML = `<p class="erro-form">${esc(e.message)} Se preferir, entre em contato pelo e-mail <a href="mailto:${esc(S.email)}">${esc(S.email)}</a>.</p>`;
    return;
  }
  const servicos = estado.config.services || [];
  if (!servicos.length) {
    el.tipos.innerHTML = '<p class="sem-horarios">A agenda online está temporariamente indisponível. Entre em contato para agendar.</p>';
    return;
  }
  el.tipos.innerHTML = servicos.map((s) => `
    <label class="opcao">
      <input type="radio" name="tipo" value="${esc(s.id)}" data-slug="${esc(s.slug)}">
      <span class="opcao-corpo">
        <span class="opcao-titulo">${esc(s.name)}</span>
        <span class="opcao-meta">${duracao(s.duration_min)}${modalidadesTexto(s)}</span>
        ${s.description ? `<span class="opcao-desc">${esc(s.description)}</span>` : ''}
      </span>
    </label>`).join('');
  app.dataset.estado = 'pronto';
  marcarVista();

  const pre = new URLSearchParams(location.search).get('tipo');
  if (pre) {
    const r = $(`input[name="tipo"][data-slug="${CSS.escape(pre)}"]`, el.tipos);
    if (r) { r.checked = true; escolherServico(r.value); }
  }
}

const duracao = (m) => m >= 60 && m % 60 === 0 ? `${m / 60} h` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
const modalidadesTexto = (s) => s.allow_presencial && s.allow_online ? ', presencial ou online' : s.allow_online ? ', somente online' : ', somente presencial';

// ---------------------------------------------------------------------
form.addEventListener('change', (e) => {
  if (e.target.name === 'tipo') escolherServico(e.target.value);
  if (e.target.name === 'modalidade') escolherModalidade(e.target.value);
});

function escolherServico(id) {
  estado.servico = estado.config.services.find((s) => s.id === id);
  el.passoMod.disabled = false;
  const permit = { presencial: estado.servico.allow_presencial, online: estado.servico.allow_online };
  for (const r of $$('input[name="modalidade"]')) {
    r.disabled = !permit[r.value];
    if (r.disabled && r.checked) r.checked = false;
  }
  const disponiveis = $$('input[name="modalidade"]').filter((r) => !r.disabled);
  if (disponiveis.length === 1) disponiveis[0].checked = true;
  const marcada = $$('input[name="modalidade"]').find((r) => r.checked);
  estado.modalidade = null;
  limparSelecao();
  if (marcada) escolherModalidade(marcada.value);
  else { el.passoData.disabled = true; el.calCorpo.innerHTML = ''; el.calTitulo.textContent = ''; }
  resumo();
}

function escolherModalidade(m) {
  estado.modalidade = m;
  estado.cursor = inicioPeriodo(hoje);
  limparSelecao();
  el.passoData.disabled = false;
  resumo();
  carregar();
}

function limparSelecao() {
  estado.dia = null; estado.slot = null;
  el.horarios.innerHTML = '';
  el.passoDados.disabled = true;
}

// ---------------------------------------------------------------------
// Períodos
// ---------------------------------------------------------------------
function inicioPeriodo(dia) {
  if (estado.vista === 'mes') return `${dia.slice(0, 7)}-01`;
  return addDias(dia, -diaSemana(dia));
}
function fimPeriodo(ini) {
  if (estado.vista === 'semana') return addDias(ini, 6);
  const [y, m] = ini.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const limiteFinal = () => addDias(hoje, estado.config.settings.max_days_ahead);

function mover(dir) {
  if (estado.vista === 'semana') estado.cursor = addDias(estado.cursor, dir * 7);
  else {
    const [y, m] = estado.cursor.split('-').map(Number);
    estado.cursor = new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
  }
  carregar();
}
el.ant.addEventListener('click', () => mover(-1));
el.prox.addEventListener('click', () => mover(1));

$$('.alternador button').forEach((b) => b.addEventListener('click', () => {
  estado.vista = b.dataset.vista;
  marcarVista();
  if (estado.modalidade) { estado.cursor = inicioPeriodo(estado.dia || estado.cursor || hoje); carregar(); }
}));
function marcarVista() {
  $$('.alternador button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vista === estado.vista)));
}

// ---------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------
async function buscar(de, ate, forcar = false) {
  const chave = `${estado.servico.id}|${estado.modalidade}|${de}|${ate}`;
  if (!forcar && estado.slots.has(chave)) return estado.slots.get(chave);
  const dados = await rpc('site_get_slots', { p_service: estado.servico.id, p_modality: estado.modalidade, p_from: de, p_to: ate });
  const porDia = {};
  for (const s of dados || []) (porDia[diaLocal(s.starts_at)] ||= []).push(s);
  estado.slots.set(chave, porDia);
  return porDia;
}

async function carregar(forcar = false) {
  const ini = estado.cursor;
  const fim = fimPeriodo(ini);
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  el.calTitulo.textContent = cap(estado.vista === 'mes'
    ? fMes(`${ini}T12:00:00-03:00`)
    : ini.slice(0, 7) === fim.slice(0, 7)
      ? `${Number(ini.slice(8))} a ${Number(fim.slice(8))} de ${fMes(`${fim}T12:00:00-03:00`)}`
      : `${Number(ini.slice(8))} de ${fMes(`${ini}T12:00:00-03:00`).split(' de ')[0]} a ${Number(fim.slice(8))} de ${fMes(`${fim}T12:00:00-03:00`)}`);
  el.ant.disabled = fim <= hoje || ini <= inicioPeriodo(hoje);
  el.prox.disabled = fim >= limiteFinal();
  el.calCorpo.setAttribute('aria-busy', 'true');
  try {
    const porDia = await buscar(ini, fim, forcar);
    if (estado.cursor !== ini) return;
    estado.vista === 'mes' ? renderMes(ini, fim, porDia) : renderSemana(ini, porDia);
    if (estado.vista === 'mes') {
      if (estado.dia && estado.dia >= ini && estado.dia <= fim) renderHorarios(estado.dia, porDia[estado.dia] || []);
      else el.horarios.innerHTML = Object.keys(porDia).length
        ? '<p class="sem-horarios">Selecione um dia em destaque para ver os horários.</p>'
        : '<p class="sem-horarios">Não há horários disponíveis neste período. Avance para o próximo mês ou entre em contato.</p>';
    } else {
      el.horarios.innerHTML = '';
    }
  } catch (e) {
    el.calCorpo.innerHTML = `<p class="erro-form">${esc(e.message)}</p>`;
  } finally {
    el.calCorpo.setAttribute('aria-busy', 'false');
  }
}

const situacao = (lista) => !lista || !lista.length ? 'ind' : lista.some((s) => s.status === 'disponivel') ? 'disp' : 'res';

function renderMes(ini, fim, porDia) {
  const nomes = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  let html = '<div class="mes" role="grid">' + nomes.map((n) => `<div class="mes-cab" role="columnheader">${n}</div>`).join('');
  for (let i = 0; i < diaSemana(ini); i++) html += '<div class="dia vazio" aria-hidden="true"></div>';
  for (let d = ini; d <= fim; d = addDias(d, 1)) {
    const lista = porDia[d];
    const sit = situacao(lista);
    const n = Number(d.slice(8));
    const cls = `dia ${sit}${d === hoje ? ' hoje' : ''}`;
    const rot = fData(`${d}T12:00:00-03:00`);
    if (sit === 'ind') {
      html += `<div class="${cls}" role="gridcell"><span aria-hidden="true">${n}</span><span class="visualmente-oculto">${rot}: indisponível</span></div>`;
    } else {
      const qtd = lista.filter((s) => s.status === 'disponivel').length;
      const desc = qtd ? `${qtd} ${qtd === 1 ? 'horário disponível' : 'horários disponíveis'}` : 'todos os horários reservados';
      html += `<button type="button" class="${cls}" role="gridcell" data-dia="${d}" aria-pressed="${estado.dia === d}" aria-label="${esc(rot)}: ${desc}">${n}</button>`;
    }
  }
  el.calCorpo.innerHTML = html + '</div>';
  $$('button.dia', el.calCorpo).forEach((b) => b.addEventListener('click', () => {
    estado.dia = b.dataset.dia; estado.slot = null; el.passoDados.disabled = true; resumo();
    $$('button.dia', el.calCorpo).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderHorarios(estado.dia, porDia[estado.dia] || []);
  }));
}

function botaoSlot(s) {
  const hora = fHora(s.starts_at);
  const sel = estado.slot && estado.slot.starts_at === s.starts_at;
  return s.status === 'disponivel'
    ? `<button type="button" class="slot" data-ini="${esc(s.starts_at)}" data-fim="${esc(s.ends_at)}" aria-pressed="${!!sel}">${hora}</button>`
    : `<button type="button" class="slot" disabled aria-label="${hora}, reservado">${hora}</button>`;
}

function renderHorarios(dia, lista) {
  const tit = fData(`${dia}T12:00:00-03:00`);
  el.horarios.innerHTML = `<h3>${esc(tit)}</h3>` + (lista.length
    ? `<div class="slots">${lista.map(botaoSlot).join('')}</div>`
    : '<p class="sem-horarios">Sem horários neste dia.</p>');
  ligarSlots(el.horarios);
}

function renderSemana(ini, porDia) {
  let html = '<div class="semana">';
  for (let i = 0; i < 7; i++) {
    const d = addDias(ini, i);
    const lista = porDia[d] || [];
    html += `<div class="sem-col${d === hoje ? ' hoje' : ''}">
      <div class="sem-cab"><span class="dsem">${fDiaSemanaCurto(`${d}T12:00:00-03:00`)}</span><span class="dnum">${Number(d.slice(8))}</span></div>
      <div class="sem-slots">${lista.length ? lista.map(botaoSlot).join('') : '<p class="sem-vazio">Indisponível</p>'}</div>
    </div>`;
  }
  el.calCorpo.innerHTML = html + '</div>';
  ligarSlots(el.calCorpo);
}

function ligarSlots(raiz) {
  $$('.slot:not(:disabled)', raiz).forEach((b) => b.addEventListener('click', () => {
    estado.slot = { starts_at: b.dataset.ini, ends_at: b.dataset.fim };
    estado.dia = diaLocal(b.dataset.ini);
    $$('.slot', app).forEach((x) => x.getAttribute('aria-pressed') !== null && x.setAttribute('aria-pressed', String(x === b)));
    el.passoDados.disabled = false;
    el.erro.hidden = true;
    resumo();
    if (window.matchMedia('(max-width: 960px)').matches) {
      setTimeout(() => el.passoDados.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    }
  }));
}

// ---------------------------------------------------------------------
function resumo() {
  const set = (n, v, vazio) => { n.textContent = v || vazio; n.classList.toggle('vazio', !v); };
  set(el.r.tipo, estado.servico && estado.servico.name, 'Não escolhido');
  set(el.r.mod, estado.modalidade && MODALIDADE[estado.modalidade], 'Não escolhida');
  set(el.r.data, estado.slot ? fData(estado.slot.starts_at) : '', 'Não escolhida');
  set(el.r.hora, estado.slot ? `${fHora(estado.slot.starts_at)} às ${fHora(estado.slot.ends_at)}` : '', 'Não escolhido');
  document.getElementById('resumo-movel').textContent = estado.slot && estado.servico
    ? `${estado.servico.name}, ${MODALIDADE[estado.modalidade].toLowerCase()}. ${fData(estado.slot.starts_at)}, ${fHora(estado.slot.starts_at)} às ${fHora(estado.slot.ends_at)}.`
    : '';
}

// ---------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------
function validar() {
  const erros = [];
  const nome = form.nome.value.trim();
  const email = form.email.value.trim();
  const tel = form.telefone.value.replace(/\D/g, '');
  const marcar = (inp, ok) => inp.setAttribute('aria-invalid', String(!ok));
  marcar(form.nome, nome.length >= 3); if (nome.length < 3) erros.push('Informe seu nome completo.');
  const okEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email); marcar(form.email, okEmail); if (!okEmail) erros.push('Informe um e-mail válido.');
  const okTel = tel.length >= 10 && tel.length <= 13; marcar(form.telefone, okTel); if (!okTel) erros.push('Informe um telefone com DDD.');
  if (!form.consentimento.checked) erros.push('Para agendar, marque a concordância com a Política de Privacidade.');
  if (!estado.slot) erros.push('Escolha um horário.');
  return erros;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (estado.enviando) return;
  const erros = validar();
  if (erros.length) { mostrarErro(erros.join(' ')); return; }
  estado.enviando = true;
  el.enviar.disabled = true;
  el.enviar.textContent = 'Confirmando…';
  el.erro.hidden = true;
  try {
    const r = await rpc('site_create_booking', {
      p_service: estado.servico.id,
      p_modality: estado.modalidade,
      p_starts_at: estado.slot.starts_at,
      p_full_name: form.nome.value,
      p_email: form.email.value,
      p_phone: form.telefone.value,
      p_note: form.obs.value || null,
      p_consent: form.consentimento.checked,
      p_hp: form.site.value || null,
    });
    confirmar(r);
  } catch (err) {
    mostrarErro(err.message);
    if (/disponível|reservado/i.test(err.message)) {
      estado.slot = null; el.passoDados.disabled = false; resumo();
      estado.slots.clear();
      await carregar(true);
    }
  } finally {
    estado.enviando = false;
    el.enviar.disabled = false;
    el.enviar.textContent = 'Confirmar agendamento';
  }
});

function mostrarErro(msg) {
  el.erro.textContent = msg;
  el.erro.hidden = false;
  el.erro.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------------------------------------------------------------------
// Confirmação
// ---------------------------------------------------------------------
function confirmar(r) {
  const nome = form.nome.value.trim();
  const confirmado = r.status === 'confirmado';
  const data = fData(r.starts_at);
  const hora = `${fHora(r.starts_at)} às ${fHora(r.ends_at)}`;
  const mod = MODALIDADE[r.modality];
  const gerenciar = `${location.origin}/agendamento/?c=${encodeURIComponent(r.code)}&t=${encodeURIComponent(r.cancel_token)}`;

  const textoWa = `Olá, Hermelany! Acabei de agendar pelo site.\n${r.service}\n${mod}\n${data}, ${hora}\nCódigo: ${r.code}\nNome: ${nome}`;
  const linkWa = S.whatsapp
    ? `https://wa.me/${S.whatsapp}?text=${encodeURIComponent(textoWa)}`
    : `mailto:${S.email}?subject=${encodeURIComponent(`Agendamento ${r.code}`)}&body=${encodeURIComponent(textoWa)}`;

  const z = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const titulo = `${r.service} — ${S.nome}`;
  const local = r.modality === 'online' ? 'Atendimento online' : (S.enderecoPresencial || 'Atendimento presencial');
  const detalhes = `Código do agendamento: ${r.code}\nGerenciar ou cancelar: ${gerenciar}`;
  const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(titulo)}&dates=${z(r.starts_at)}/${z(r.ends_at)}&details=${encodeURIComponent(detalhes)}&location=${encodeURIComponent(local)}`;
  const icsEsc = (s) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hermelany Antunes//Agenda//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${r.code}@hermelany-antunes`, `DTSTAMP:${z(new Date().toISOString())}`, `DTSTART:${z(r.starts_at)}`, `DTEND:${z(r.ends_at)}`,
    `SUMMARY:${icsEsc(titulo)}`, `DESCRIPTION:${icsEsc(detalhes)}`, `LOCATION:${icsEsc(local)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const icsUrl = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));

  const emailInfo = estado.config.settings.email_confirmation
    ? `<p>Uma confirmação foi enviada para <strong>${esc(form.email.value.trim())}</strong>. Verifique também a caixa de spam.</p>`
    : '';
  const endereco = r.modality === 'presencial' && S.enderecoPresencial ? `<p><strong>Endereço:</strong> ${esc(S.enderecoPresencial)}</p>` : '';

  el.conf.innerHTML = `
    <p class="conf-selo"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>${confirmado ? 'Horário reservado' : 'Solicitação registrada'}</p>
    <h2>${confirmado ? 'Agendamento confirmado' : 'Recebemos sua solicitação'}</h2>
    <p class="lead">${confirmado
      ? `${esc(nome.split(' ')[0])}, seu horário está reservado. Guarde o código e o link abaixo para consultar ou cancelar.`
      : `${esc(nome.split(' ')[0])}, o horário fica reservado para você enquanto a confirmação é feita. Você receberá o retorno pelo contato informado.`}</p>
    <dl class="conf-dados">
      <div><dt>Atendimento</dt><dd>${esc(r.service)}</dd></div>
      <div><dt>Data</dt><dd>${esc(data)}</dd></div>
      <div><dt>Horário</dt><dd>${esc(hora)}</dd></div>
      <div><dt>Modalidade</dt><dd>${esc(mod)}</dd></div>
      <div><dt>Código</dt><dd class="codigo">${esc(r.code)}</dd></div>
    </dl>
    ${emailInfo}
    <div class="conf-orient"><h3>Orientações</h3>${endereco}<p>${esc(r.instructions || '')}</p></div>
    <div class="grupo-botoes">
      <a class="botao botao-primario" href="${esc(linkWa)}" ${S.whatsapp ? 'target="_blank" rel="noopener"' : ''}>${S.whatsapp ? 'Enviar confirmação pelo WhatsApp' : 'Enviar confirmação por e-mail'}</a>
      <a class="botao botao-secundario" href="${esc(gcal)}" target="_blank" rel="noopener">Adicionar ao Google Agenda</a>
      <a class="botao botao-secundario" href="${icsUrl}" download="agendamento-${esc(r.code)}.ics">Baixar para outra agenda (.ics)</a>
    </div>
    <p class="nota" style="margin-top:1.5rem">Precisa cancelar? Use o link <a href="${esc(gerenciar)}">gerenciar agendamento</a>, que fica disponível até o horário marcado.</p>`;
  app.dataset.estado = 'confirmado';
  el.conf.hidden = false;
  window.scrollTo({ top: app.getBoundingClientRect().top + window.scrollY - 100, behavior: 'smooth' });
  el.conf.focus({ preventScroll: true });
}

iniciar();
