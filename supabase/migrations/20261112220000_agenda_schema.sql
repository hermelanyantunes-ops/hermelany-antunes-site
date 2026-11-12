-- =====================================================================
-- Agenda online — site de Hermelany Antunes
-- Esquema isolado "agenda" dentro do projeto Supabase existente.
-- Nenhuma tabela ou função pré-existente é alterada.
-- As tabelas NÃO são expostas pela API REST: todo acesso passa por
-- funções RPC (public.site_*) com validação e controle de acesso.
-- Não armazena prontuários, resultados de testes ou dados clínicos.
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

create schema if not exists agenda;
revoke all on schema agenda from public;
revoke all on schema agenda from anon, authenticated;

-- ---------------------------------------------------------------------
-- Usuários autorizados a acessar o painel
-- ---------------------------------------------------------------------
create table agenda.admins (
  email      text primary key check (email = lower(email) and position('@' in email) > 1),
  created_at timestamptz not null default now()
);
insert into agenda.admins (email) values ('hermelanyantunes@gmail.com');

-- ---------------------------------------------------------------------
-- Configurações gerais (linha única)
-- ---------------------------------------------------------------------
create table agenda.settings (
  id                     boolean primary key default true check (id),
  timezone               text    not null default 'America/Recife',
  slot_step_min          int     not null default 60  check (slot_step_min between 5 and 240),
  min_notice_hours       int     not null default 12  check (min_notice_hours between 0 and 720),
  max_days_ahead         int     not null default 60  check (max_days_ahead between 1 and 365),
  buffer_min             int     not null default 10  check (buffer_min between 0 and 120),
  auto_confirm           boolean not null default true,
  max_active_per_email   int     not null default 3   check (max_active_per_email between 1 and 20),
  instructions_presencial text   default 'Chegue com 10 minutos de antecedência. Caso precise remarcar, avise com pelo menos 24 horas.',
  instructions_online     text   default 'Você receberá o link da videochamada antes do horário. Escolha um local reservado, com boa conexão e fones de ouvido.',
  updated_at             timestamptz not null default now()
);
insert into agenda.settings default values;

-- ---------------------------------------------------------------------
-- Tipos de atendimento (duração configurável)
-- ---------------------------------------------------------------------
create table agenda.service_types (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name             text not null check (length(name) between 2 and 120),
  description      text check (length(description) <= 600),
  duration_min     int  not null check (duration_min between 10 and 600),
  allow_presencial boolean not null default true,
  allow_online     boolean not null default true,
  public_booking   boolean not null default true,
  active           boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now()
);

insert into agenda.service_types (slug, name, description, duration_min, sort_order) values
 ('primeira-consulta', 'Primeira consulta psicológica',
  'Primeiro encontro para compreender a demanda e conversar sobre os caminhos de cuidado.', 50, 1),
 ('acompanhamento', 'Sessão de acompanhamento psicológico',
  'Sessões de psicoterapia para quem já iniciou o acompanhamento.', 50, 2),
 ('entrevista-inicial-avaliacao', 'Entrevista inicial para avaliação neuropsicológica',
  'Primeiro passo da avaliação: compreensão da demanda e levantamento da história clínica.', 60, 3),
 ('sessao-avaliacao', 'Avaliação neuropsicológica (sessão)',
  'Sessão do processo avaliativo. O número de sessões é definido individualmente, após a entrevista inicial.', 90, 4),
 ('devolutiva', 'Entrevista devolutiva',
  'Apresentação dos resultados, orientações e entrega do relatório.', 60, 5);

-- ---------------------------------------------------------------------
-- Disponibilidade recorrente semanal
-- weekday: 0 = domingo ... 6 = sábado
-- modality: presencial | online | ambas
-- service_type_id nulo = vale para todos os tipos
-- ---------------------------------------------------------------------
create table agenda.availability_rules (
  id              uuid primary key default gen_random_uuid(),
  weekday         smallint not null check (weekday between 0 and 6),
  start_time      time not null,
  end_time        time not null,
  modality        text not null default 'ambas' check (modality in ('presencial','online','ambas')),
  service_type_id uuid references agenda.service_types(id) on delete cascade,
  valid_from      date,
  valid_until     date,
  active          boolean not null default true,
  note            text check (length(note) <= 200),
  created_at      timestamptz not null default now(),
  check (end_time > start_time),
  check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

-- Disponibilidade inicial de exemplo (editável no painel)
insert into agenda.availability_rules (weekday, start_time, end_time, modality, note)
select d, t.s, t.e, 'ambas', 'Horário inicial — ajuste no painel'
from generate_series(1,5) d,
     (values ('08:00'::time,'12:00'::time), ('14:00'::time,'18:00'::time)) t(s,e);

-- ---------------------------------------------------------------------
-- Bloqueios, intervalos e férias (datas específicas)
-- ---------------------------------------------------------------------
create table agenda.time_blocks (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  kind       text not null default 'bloqueio' check (kind in ('bloqueio','ferias','intervalo','feriado','outro')),
  modality   text check (modality in ('presencial','online')),  -- nulo = bloqueia ambas
  reason     text check (length(reason) <= 200),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on agenda.time_blocks using gist (tstzrange(starts_at, ends_at, '[)'));

-- ---------------------------------------------------------------------
-- Horários extras liberados pontualmente
-- ---------------------------------------------------------------------
create table agenda.extra_slots (
  id              uuid primary key default gen_random_uuid(),
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  modality        text not null default 'ambas' check (modality in ('presencial','online','ambas')),
  service_type_id uuid references agenda.service_types(id) on delete cascade,
  note            text check (length(note) <= 200),
  created_at      timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- ---------------------------------------------------------------------
-- Agendamentos (somente dados administrativos)
-- ---------------------------------------------------------------------
create table agenda.bookings (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
  service_type_id uuid not null references agenda.service_types(id),
  modality        text not null check (modality in ('presencial','online')),
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text not null default 'confirmado'
                  check (status in ('pendente','confirmado','cancelado','concluido','faltou')),
  full_name       text not null check (length(full_name) between 3 and 120),
  email           text not null check (length(email) <= 160 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone           text not null check (length(phone) between 8 and 30),
  patient_note    text check (length(patient_note) <= 400),   -- observação administrativa opcional
  internal_note   text check (length(internal_note) <= 600),  -- anotação administrativa da psicóloga
  source          text not null default 'site' check (source in ('site','admin')),
  consent_at      timestamptz,
  cancel_token    uuid not null default gen_random_uuid(),
  gcal_event_id   text,
  gcal_synced_at  timestamptz,
  email_sent_at   timestamptz,
  email_cancel_sent_at timestamptz,
  sync_error      text,
  cancelled_at    timestamptz,
  cancelled_by    text check (cancelled_by in ('paciente','admin')),
  anonymized_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Garantia definitiva contra conflitos: dois atendimentos ativos nunca se sobrepõem
  constraint bookings_no_overlap exclude using gist (
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pendente','confirmado'))
);
create index on agenda.bookings (starts_at);
create index on agenda.bookings (lower(email));

-- ---------------------------------------------------------------------
-- Ocupações vindas do Google Agenda (somente início/fim)
-- ---------------------------------------------------------------------
create table agenda.external_busy (
  id         bigint generated always as identity primary key,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  source     text not null default 'google',
  fetched_at timestamptz not null default now()
);
create index on agenda.external_busy using gist (tstzrange(starts_at, ends_at, '[)'));

-- ---------------------------------------------------------------------
-- Estado das integrações (sem segredos — segredos ficam no Vault)
-- ---------------------------------------------------------------------
create table agenda.integration (
  id                 boolean primary key default true check (id),
  google_client_id   text,
  google_connected   boolean not null default false,
  google_email       text,
  google_calendar_id text not null default 'primary',
  send_emails        boolean not null default true,
  last_sync_at       timestamptz,
  last_sync_error    text,
  function_url       text not null default 'https://hpjnthwubydqrbdncapf.supabase.co/functions/v1/agenda-google',
  site_url           text not null default 'https://hermelany-antunes.web.app',
  updated_at         timestamptz not null default now()
);
insert into agenda.integration default values;

create table agenda.oauth_states (
  state      text primary key,
  user_email text not null,
  expires_at timestamptz not null default now() + interval '15 minutes'
);

-- RLS habilitado em todas as tabelas, sem políticas: nenhum acesso direto.
alter table agenda.admins             enable row level security;
alter table agenda.settings           enable row level security;
alter table agenda.service_types      enable row level security;
alter table agenda.availability_rules enable row level security;
alter table agenda.time_blocks        enable row level security;
alter table agenda.extra_slots        enable row level security;
alter table agenda.bookings           enable row level security;
alter table agenda.external_busy      enable row level security;
alter table agenda.integration        enable row level security;
alter table agenda.oauth_states       enable row level security;

revoke all on all tables in schema agenda from public, anon, authenticated;
revoke all on all sequences in schema agenda from public, anon, authenticated;

-- updated_at automático
create or replace function agenda.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger bookings_touch before update on agenda.bookings
  for each row execute function agenda.touch_updated_at();
create trigger settings_touch before update on agenda.settings
  for each row execute function agenda.touch_updated_at();
create trigger integration_touch before update on agenda.integration
  for each row execute function agenda.touch_updated_at();

-- Segredo interno para chamadas banco → Edge Function (gerado aleatoriamente)
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'agenda_internal_key',
                           'Chave interna da agenda do site (banco -> edge function)');
