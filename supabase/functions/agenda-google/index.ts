// =====================================================================
// Edge Function: agenda-google
// Integração da agenda do site com Google Agenda e Gmail (OAuth 2.0)
//
// Rotas
//   POST /start         (admin)          inicia a autorização OAuth
//   GET  /callback      (Google)         recebe o código e guarda o token
//   POST /sync-booking  (banco/admin)    cria, altera ou remove o evento de um agendamento
//   POST /sync-all      (cron/admin)     lê compromissos ocupados e sincroniza pendências
//   POST /disconnect    (admin)          revoga e remove o token
//
// Segredos ficam no Supabase Vault. Nenhuma chave no código-fonte.
// =====================================================================
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20 });
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ADMIN_PRINCIPAL = "hermelanyantunes@gmail.com";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-agenda-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------
// Utilidades de banco / segredos
// ---------------------------------------------------------------------
async function segredo(nome: string): Promise<string | null> {
  const r = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${nome} limit 1`;
  return r.length ? r[0].decrypted_secret : null;
}
async function gravarSegredo(nome: string, valor: string) {
  const r = await sql`select id from vault.secrets where name = ${nome} limit 1`;
  if (r.length) await sql`select vault.update_secret(${r[0].id}::uuid, ${valor})`;
  else await sql`select vault.create_secret(${valor}, ${nome}, 'Agenda do site')`;
}
async function apagarSegredo(nome: string) {
  await sql`delete from vault.secrets where name = ${nome}`;
}
async function integracao() {
  const [i] = await sql`select * from agenda.integration where id`;
  return i;
}

// ---------------------------------------------------------------------
// Autenticação das chamadas
// ---------------------------------------------------------------------
async function exigirAdmin(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || "";
  if (!auth.startsWith("Bearer ") || !apikey) throw new HttpError(401, "Não autenticado.");
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!r.ok) throw new HttpError(401, "Sessão inválida. Entre novamente no painel.");
  const u = await r.json();
  const email = String(u.email || "").toLowerCase();
  if (!u.email_confirmed_at) throw new HttpError(403, "Acesso restrito.");
  const ok = await sql`select 1 from agenda.admins where email = ${email}`;
  if (!ok.length) throw new HttpError(403, "Acesso restrito.");
  return email;
}
async function chaveInterna(req: Request): Promise<boolean> {
  const k = req.headers.get("x-agenda-key");
  if (!k) return false;
  const esperado = await segredo("agenda_internal_key");
  return !!esperado && k.length === esperado.length && igual(k, esperado);
}
function igual(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function exigirInternoOuAdmin(req: Request) {
  if (await chaveInterna(req)) return "interno";
  return await exigirAdmin(req);
}

// ---------------------------------------------------------------------
// Google OAuth
// ---------------------------------------------------------------------
const callbackUrl = (i: any) => `${i.function_url.replace(/\/$/, "")}/callback`;
let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const i = await integracao();
  const refresh = await segredo("agenda_google_refresh_token");
  const secret = await segredo("agenda_google_client_secret");
  if (!i.google_connected || !refresh || !secret || !i.google_client_id) throw new HttpError(409, "Google Agenda não conectado.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: i.google_client_id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const d = await r.json();
  if (!r.ok) {
    if (d.error === "invalid_grant") {
      await sql`update agenda.integration set google_connected = false, last_sync_error = 'A autorização do Google expirou ou foi revogada. Clique em Reconectar.' where id`;
    }
    throw new HttpError(502, `Google: ${d.error_description || d.error || "falha ao renovar acesso"}`);
  }
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function google(method: string, url: string, body?: unknown) {
  const t = await accessToken();
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${t}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  return { ok: r.ok, status: r.status, data };
}

async function rotaStart(req: Request) {
  const email = await exigirAdmin(req);
  const i = await integracao();
  if (!i.google_client_id) throw new HttpError(400, "Cadastre o ID do cliente do Google antes de conectar.");
  if (!(await segredo("agenda_google_client_secret"))) throw new HttpError(400, "Cadastre a chave secreta do cliente antes de conectar.");
  const corpo = await req.json().catch(() => ({}));
  let retorno = `${i.site_url.replace(/\/$/, "")}/admin/`;
  if (typeof corpo.return_to === "string" && /^(https:\/\/[^\s/]+|http:\/\/localhost(:\d+)?)\/admin\/$/.test(corpo.return_to)) retorno = corpo.return_to;
  const state = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await sql`delete from agenda.oauth_states where expires_at < now()`;
  await sql`insert into agenda.oauth_states (state, user_email, return_to) values (${state}, ${email}, ${retorno})`;
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: i.google_client_id,
    redirect_uri: callbackUrl(i),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: ADMIN_PRINCIPAL,
    state,
  });
  return json({ url });
}

async function rotaCallback(url: URL) {
  const state = url.searchParams.get("state") || "";
  const [s] = await sql`delete from agenda.oauth_states where state = ${state} and expires_at > now() returning *`;
  const i = await integracao();
  const voltar = (ok: boolean, motivo = "") => {
    const base = (s && s.return_to) || `${i.site_url.replace(/\/$/, "")}/admin/`;
    return new Response(null, { status: 302, headers: { Location: `${base}?google=${ok ? "ok" : "erro"}${motivo ? `&motivo=${encodeURIComponent(motivo)}` : ""}` } });
  };
  if (!s) return voltar(false, "link de autorização expirado");
  if (url.searchParams.get("error")) return voltar(false, url.searchParams.get("error") || "");
  const code = url.searchParams.get("code");
  if (!code) return voltar(false, "código ausente");

  const secret = await segredo("agenda_google_client_secret");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: i.google_client_id, client_secret: secret!, code, redirect_uri: callbackUrl(i), grant_type: "authorization_code" }),
  });
  const d = await r.json();
  if (!r.ok) return voltar(false, d.error_description || d.error || "falha na troca do código");
  if (!d.refresh_token) return voltar(false, "o Google não enviou o token de acesso contínuo; remova o acesso do app em myaccount.google.com/permissions e tente novamente");
  const escopos = String(d.scope || "");
  if (!escopos.includes("calendar.events")) return voltar(false, "a permissão de acesso ao Google Agenda não foi concedida");

  let email = "";
  try { email = JSON.parse(atob(d.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch { /* sem e-mail */ }
  await gravarSegredo("agenda_google_refresh_token", d.refresh_token);
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  await sql`update agenda.integration set google_connected = true, google_email = ${email || null}, last_sync_error = null where id`;
  try { await sincronizarTudo(); } catch (e) { console.error("sync inicial", e); }
  return voltar(true);
}

async function rotaDisconnect(req: Request) {
  await exigirAdmin(req);
  const refresh = await segredo("agenda_google_refresh_token");
  if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
  await apagarSegredo("agenda_google_refresh_token");
  tokenCache = null;
  await sql`update agenda.integration set google_connected = false, google_email = null where id`;
  await sql`delete from agenda.external_busy where source = 'google'`;
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Sincronização de agendamentos
// ---------------------------------------------------------------------
const calBase = (i: any) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(i.google_calendar_id || "primary")}`;
const MOD: Record<string, string> = { presencial: "Presencial", online: "Online" };

async function sincronizarAgendamento(id: string) {
  const i = await integracao();
  if (!i.google_connected) return { skipped: true };
  const [b] = await sql`
    select b.*, t.name as service_name
    from agenda.bookings b join agenda.service_types t on t.id = b.service_type_id
    where b.id = ${id}`;
  if (!b || b.anonymized_at) return { skipped: true };
  const [s] = await sql`select * from agenda.settings where id`;
  const erros: string[] = [];

  try {
    const ativo = b.status === "pendente" || b.status === "confirmado";
    if (ativo) {
      const evento = {
        summary: `${b.service_name} — ${b.full_name}${b.status === "pendente" ? " (pendente)" : ""}`,
        description: [
          `Modalidade: ${MOD[b.modality]}`,
          `Telefone: ${b.phone}`,
          `E-mail: ${b.email}`,
          b.patient_note ? `Observação: ${b.patient_note}` : "",
          `Código: ${b.code}`,
          `Origem: ${b.source === "site" ? "agenda do site" : "painel"}`,
        ].filter(Boolean).join("\n"),
        location: b.modality === "online" ? "Atendimento online" : undefined,
        start: { dateTime: new Date(b.starts_at).toISOString(), timeZone: s.timezone },
        end: { dateTime: new Date(b.ends_at).toISOString(), timeZone: s.timezone },
        extendedProperties: { private: { agendaBookingId: b.id } },
        transparency: "opaque",
      };
      let eventId: string | null = b.gcal_event_id;
      if (!eventId) {
        const busca = await google("GET", `${calBase(i)}/events?privateExtendedProperty=${encodeURIComponent(`agendaBookingId=${b.id}`)}&showDeleted=false&maxResults=1`);
        if (busca.ok && busca.data.items && busca.data.items.length) eventId = busca.data.items[0].id;
      }
      let r = eventId ? await google("PATCH", `${calBase(i)}/events/${encodeURIComponent(eventId)}`, evento) : null;
      if (!r || r.status === 404 || r.status === 410) r = await google("POST", `${calBase(i)}/events`, evento);
      if (!r.ok) throw new Error(`Google Agenda: ${r.data?.error?.message || r.status}`);
      await sql`update agenda.bookings set gcal_event_id = ${r.data.id}, gcal_synced_at = now() where id = ${b.id}`;
    } else if (b.status === "cancelado" && b.gcal_event_id) {
      const r = await google("DELETE", `${calBase(i)}/events/${encodeURIComponent(b.gcal_event_id)}`);
      if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`Google Agenda: ${r.data?.error?.message || r.status}`);
      await sql`update agenda.bookings set gcal_event_id = null, gcal_synced_at = now() where id = ${b.id}`;
    } else {
      await sql`update agenda.bookings set gcal_synced_at = now() where id = ${b.id}`;
    }
  } catch (e) {
    erros.push((e as Error).message);
  }

  // E-mails ao paciente (somente agendamentos feitos pelo site)
  if (i.send_emails && b.source === "site") {
    try {
      if ((b.status === "confirmado" || b.status === "pendente") && !b.email_sent_at && new Date(b.starts_at) > new Date()) {
        await enviarEmail(i, s, b, "confirmacao");
        await sql`update agenda.bookings set email_sent_at = now() where id = ${b.id}`;
      } else if (b.status === "cancelado" && b.email_sent_at && !b.email_cancel_sent_at) {
        await enviarEmail(i, s, b, "cancelamento");
        await sql`update agenda.bookings set email_cancel_sent_at = now() where id = ${b.id}`;
      }
    } catch (e) {
      erros.push(`E-mail: ${(e as Error).message}`);
    }
  }

  await sql`update agenda.bookings set sync_error = ${erros.length ? erros.join(" | ").slice(0, 500) : null} where id = ${b.id}`;
  return { ok: erros.length === 0, errors: erros };
}

async function lerOcupados() {
  const i = await integracao();
  const [s] = await sql`select * from agenda.settings where id`;
  const ini = new Date();
  const fim = new Date(Date.now() + (s.max_days_ahead + 2) * 86400000);
  const periodos: { a: string; b: string }[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({
      timeMin: ini.toISOString(), timeMax: fim.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "2500",
      fields: "nextPageToken,items(id,status,transparency,start,end,extendedProperties)",
      ...(pageToken ? { pageToken } : {}),
    });
    const r = await google("GET", `${calBase(i)}/events?${q}`);
    if (!r.ok) throw new Error(`Google Agenda: ${r.data?.error?.message || r.status}`);
    for (const ev of r.data.items || []) {
      if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
      if (ev.extendedProperties?.private?.agendaBookingId) continue; // eventos criados pela própria agenda
      const a = ev.start?.dateTime || (ev.start?.date && `${ev.start.date}T00:00:00-03:00`);
      const b = ev.end?.dateTime || (ev.end?.date && `${ev.end.date}T00:00:00-03:00`);
      if (a && b) periodos.push({ a: new Date(a).toISOString(), b: new Date(b).toISOString() });
    }
    pageToken = r.data.nextPageToken || "";
  } while (pageToken);

  await sql.begin(async (tx) => {
    await tx`delete from agenda.external_busy where source = 'google'`;
    if (periodos.length) {
      await tx`insert into agenda.external_busy ${tx(periodos.map((p) => ({ starts_at: p.a, ends_at: p.b, source: "google" })))}`;
    }
  });
  return periodos.length;
}

async function sincronizarTudo() {
  const i = await integracao();
  if (!i.google_connected) return { skipped: true };
  let busy = 0;
  let erro: string | null = null;
  try { busy = await lerOcupados(); } catch (e) { erro = (e as Error).message; }
  const pend = await sql`
    select id from agenda.bookings
    where anonymized_at is null
      and ends_at > now() - interval '1 day'
      and (gcal_synced_at is null or updated_at > gcal_synced_at
           or (status = 'cancelado' and gcal_event_id is not null))
    order by starts_at limit 40`;
  let n = 0;
  for (const p of pend) {
    const r = await sincronizarAgendamento(p.id);
    if (r.ok) n++;
    else if (!erro && r.errors) erro = r.errors[0];
  }
  await sql`update agenda.integration set last_sync_at = now(), last_sync_error = ${erro} where id`;
  return { busy, bookings: n, error: erro };
}

// ---------------------------------------------------------------------
// E-mail via Gmail API (enviado pela conta conectada)
// ---------------------------------------------------------------------
const TZ = "America/Recife";
const fData = (d: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
const fHora = (d: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);
const escHtml = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64url = (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const quebrar = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

async function enviarEmail(i: any, s: any, b: any, tipo: "confirmacao" | "cancelamento") {
  const ini = new Date(b.starts_at);
  const fim = new Date(b.ends_at);
  const primeiro = String(b.full_name).split(" ")[0];
  const site = String(i.site_url).replace(/\/$/, "");
  const gerenciar = `${site}/agendamento/?c=${encodeURIComponent(b.code)}&t=${encodeURIComponent(b.cancel_token)}`;
  const quando = `${fData(ini)}, das ${fHora(ini)} às ${fHora(fim)}`;
  const orient = b.modality === "online" ? s.instructions_online : s.instructions_presencial;
  const remetente = i.google_email || ADMIN_PRINCIPAL;

  const assunto = tipo === "confirmacao"
    ? `${b.status === "pendente" ? "Solicitação de agendamento recebida" : "Agendamento confirmado"}: ${fData(ini)} às ${fHora(ini)}`
    : `Agendamento cancelado: ${fData(ini)} às ${fHora(ini)}`;

  const linhas = tipo === "confirmacao"
    ? [
      `Olá, ${primeiro}!`,
      b.status === "pendente"
        ? "Recebi sua solicitação de agendamento. O horário está reservado para você e retornarei com a confirmação."
        : "Seu agendamento está confirmado.",
      "",
      `Atendimento: ${b.service_name}`,
      `Data e horário: ${quando} (horário de Recife)`,
      `Modalidade: ${MOD[b.modality]}`,
      `Código: ${b.code}`,
      "",
      orient ? `Orientações: ${orient}` : "",
      "",
      `Para consultar ou cancelar: ${gerenciar}`,
    ]
    : [
      `Olá, ${primeiro}.`,
      "O agendamento abaixo foi cancelado.",
      "",
      `Atendimento: ${b.service_name}`,
      `Data e horário: ${quando}`,
      `Código: ${b.code}`,
      "",
      `Se quiser escolher um novo horário: ${site}/agendar/`,
    ];
  const assinatura = ["", "Hermelany Antunes", "Psicóloga, CRP 02/26332", site, "", "Mensagem automática da agenda online. Não envie informações clínicas por e-mail."];
  const texto = [...linhas, ...assinatura].join("\r\n");

  const det = (r: string, v: string) => `<tr><td style="padding:6px 16px 6px 0;color:#4D5852;font-size:14px;vertical-align:top">${escHtml(r)}</td><td style="padding:6px 0;color:#1E3B32;font-size:15px">${escHtml(v)}</td></tr>`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F0EEE6;font-family:Georgia,'Times New Roman',serif;color:#1C2420">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE6"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td style="background:#1E3B32;padding:24px 28px;border-radius:8px 8px 0 0;color:#ffffff;font-size:20px">Hermelany Antunes<div style="font-family:Arial,sans-serif;font-size:12px;color:#E9E2D2;margin-top:4px">Psicóloga, CRP 02/26332</div></td></tr>
<tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">${escHtml(linhas[0])}</p><p style="margin:0 0 20px">${escHtml(linhas[1])}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid #E6DECD;border-bottom:1px solid #E6DECD;padding:8px 0;margin-bottom:20px;width:100%">
${det("Atendimento", b.service_name)}${det("Data e horário", quando)}${tipo === "confirmacao" ? det("Modalidade", MOD[b.modality]) : ""}${det("Código", b.code)}
</table>
${tipo === "confirmacao" && orient ? `<p style="margin:0 0 20px;background:#F0EEE6;padding:14px 16px;border-radius:6px"><strong>Orientações:</strong> ${escHtml(orient)}</p>` : ""}
${tipo === "confirmacao"
      ? `<p style="margin:0 0 8px"><a href="${escHtml(gerenciar)}" style="display:inline-block;background:#1E3B32;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px">Consultar ou cancelar</a></p>`
      : `<p style="margin:0 0 8px"><a href="${escHtml(site)}/agendar/" style="display:inline-block;background:#1E3B32;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px">Escolher novo horário</a></p>`}
</td></tr>
<tr><td style="padding:18px 28px 26px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#4D5852;border-top:1px solid #E6DECD">Mensagem automática da agenda online. Por segurança, não envie informações clínicas por e-mail.<br><a href="${escHtml(site)}" style="color:#7A5A36">${escHtml(site.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;

  const limite = "agenda_" + crypto.randomUUID().replace(/-/g, "");
  const mime = [
    `From: =?UTF-8?B?${b64("Hermelany Antunes")}?= <${remetente}>`,
    `To: ${b.email}`,
    `Subject: =?UTF-8?B?${b64(assunto)}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${limite}"`,
    "",
    `--${limite}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    quebrar(b64(texto)),
    `--${limite}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    quebrar(b64(html)),
    `--${limite}--`,
  ].join("\r\n");

  const r = await google("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw: b64url(mime) });
  if (!r.ok) throw new Error(r.data?.error?.message || `status ${r.status}`);
}

// ---------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^.*\/agenda-google/, "") || "/";
  try {
    if (rota === "/callback" && req.method === "GET") return await rotaCallback(url);
    if (req.method !== "POST") throw new HttpError(405, "Método não permitido.");
    if (rota === "/start") return await rotaStart(req);
    if (rota === "/disconnect") return await rotaDisconnect(req);
    if (rota === "/sync-booking") {
      await exigirInternoOuAdmin(req);
      const { booking_id } = await req.json();
      if (!/^[0-9a-f-]{36}$/i.test(String(booking_id))) throw new HttpError(400, "Identificador inválido.");
      return json(await sincronizarAgendamento(booking_id));
    }
    if (rota === "/sync-all") {
      await exigirInternoOuAdmin(req);
      return json(await sincronizarTudo());
    }
    throw new HttpError(404, "Rota não encontrada.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return json({ error: status === 500 ? "Erro interno na integração." : (e as Error).message }, status);
  }
});
