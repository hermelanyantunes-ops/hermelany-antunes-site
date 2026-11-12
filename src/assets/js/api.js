// Cliente mínimo para o Supabase (REST/RPC + Auth), sem dependências.
const { supabaseUrl, supabaseKey } = window.SITE;

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function request(path, { method = 'POST', body, token, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${supabaseUrl}${path}`, {
      method,
      headers: {
        apikey: supabaseKey,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua internet e tente novamente.', 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || 'Não foi possível concluir a operação.';
    throw new ApiError(traduzir(msg), res.status, data && data.code);
  }
  return data;
}

function traduzir(msg) {
  const m = String(msg);
  if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/Email not confirmed/i.test(m)) return 'E-mail ainda não confirmado.';
  if (/JWT expired/i.test(m)) return 'Sua sessão expirou. Entre novamente.';
  if (/rate limit/i.test(m)) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  if (/Password should be/i.test(m)) return 'A senha deve ter pelo menos 8 caracteres.';
  return m;
}

export const rpc = (fn, args = {}, token) => request(`/rest/v1/rpc/${fn}`, { body: args, token });

// ---------------------------------------------------------------------
// Autenticação (painel administrativo)
// ---------------------------------------------------------------------
const CHAVE = 'ha-admin-sessao';
const guardar = (s) => { try { s ? localStorage.setItem(CHAVE, JSON.stringify(s)) : localStorage.removeItem(CHAVE); } catch {} };
const ler = () => { try { return JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch { return null; } };

function normalizar(d) {
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    email: d.user && d.user.email,
  };
}

export const auth = {
  async entrar(email, password) {
    const d = await request('/auth/v1/token?grant_type=password', { body: { email, password } });
    const s = normalizar(d); guardar(s); return s;
  },
  async renovar(refresh_token) {
    const d = await request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token } });
    const s = normalizar(d); guardar(s); return s;
  },
  async token() {
    let s = ler();
    if (!s) return null;
    if (s.expires_at - 60 < Date.now() / 1000) {
      try { s = await this.renovar(s.refresh_token); } catch { guardar(null); return null; }
    }
    return s.access_token;
  },
  sessao: ler,
  definirSessao(params) {
    const s = normalizar({ access_token: params.access_token, refresh_token: params.refresh_token,
      expires_in: Number(params.expires_in || 3600) });
    guardar(s); return s;
  },
  async sair() {
    const s = ler();
    guardar(null);
    if (s) { try { await request('/auth/v1/logout', { token: s.access_token }); } catch {} }
  },
  recuperar(email, redirectTo) {
    return request(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { email } });
  },
  async novaSenha(password) {
    const t = await this.token();
    return request('/auth/v1/user', { method: 'PUT', body: { password }, token: t });
  },
};

// ---------------------------------------------------------------------
// Datas (fuso fixo de Recife)
// ---------------------------------------------------------------------
export const TZ = window.SITE.timezone || 'America/Recife';
const fmt = (opts) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts });
export const fData = (d) => fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d));
export const fDataCurta = (d) => fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
export const fHora = (d) => fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(d));
export const fMes = (d) => fmt({ month: 'long', year: 'numeric' }).format(new Date(d));
export const fDiaSemanaCurto = (d) => fmt({ weekday: 'short' }).format(new Date(d)).replace('.', '');

// "YYYY-MM-DD" da data no fuso de Recife
export function diaLocal(d) {
  const p = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
// Recife não tem horário de verão: UTC-03:00 fixo
export const OFFSET = '-03:00';
export const isoLocal = (dia, hora) => new Date(`${dia}T${hora}:00${OFFSET}`).toISOString();
export function addDias(dia, n) {
  const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export const diaSemana = (dia) => new Date(`${dia}T12:00:00Z`).getUTCDay();

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const MODALIDADE = { presencial: 'Presencial', online: 'Online', ambas: 'Presencial e online' };
