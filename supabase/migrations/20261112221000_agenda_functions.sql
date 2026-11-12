-- =====================================================================
-- Funções da agenda
--   agenda.*           : internas (não expostas)
--   public.site_*      : RPC chamadas pelo site (público) e pelo painel (admin)
-- Todas usam SECURITY DEFINER + search_path vazio.
-- =====================================================================

alter table agenda.oauth_states add column if not exists return_to text;

-- ---------------------------------------------------------------------
-- Controle de acesso
-- ---------------------------------------------------------------------
create or replace function agenda.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from auth.users u
    join agenda.admins a on a.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;

create or replace function agenda.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not agenda.is_admin() then
    raise exception 'Acesso restrito.' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Geração de horários
-- ---------------------------------------------------------------------
create or replace function agenda.compute_slots(
  p_service uuid, p_modality text, p_from date, p_to date
) returns table (starts_at timestamptz, ends_at timestamptz, status text)
language plpgsql stable security definer set search_path = '' as $$
declare
  s        agenda.settings;
  st       agenda.service_types;
  tz       text;
  dur      interval;
  step     interval;
  buf      interval;
  earliest timestamptz;
  d_from   date;
  d_to     date;
begin
  select * into s from agenda.settings where id;
  select * into st from agenda.service_types t where t.id = p_service and t.active;
  if not found or p_modality not in ('presencial','online') then return; end if;
  if (p_modality = 'presencial' and not st.allow_presencial)
     or (p_modality = 'online' and not st.allow_online) then return; end if;

  tz       := s.timezone;
  dur      := make_interval(mins => st.duration_min);
  step     := make_interval(mins => s.slot_step_min);
  buf      := make_interval(mins => s.buffer_min);
  earliest := now() + make_interval(hours => s.min_notice_hours);
  d_from   := greatest(p_from, (now() at time zone tz)::date);
  d_to     := least(p_to, (now() at time zone tz)::date + s.max_days_ahead);
  if d_to < d_from then return; end if;

  return query
  with days as (
    select g::date as d from generate_series(d_from, d_to, interval '1 day') g
  ),
  windows as (
    select (dd.d + r.start_time) at time zone tz as ws,
           (dd.d + r.end_time)   at time zone tz as we
    from days dd
    join agenda.availability_rules r
      on r.active
     and r.weekday = extract(dow from dd.d)
     and (r.valid_from  is null or dd.d >= r.valid_from)
     and (r.valid_until is null or dd.d <= r.valid_until)
     and r.modality in (p_modality, 'ambas')
     and (r.service_type_id is null or r.service_type_id = p_service)
    union all
    select e.starts_at, e.ends_at
    from agenda.extra_slots e
    where e.modality in (p_modality, 'ambas')
      and (e.service_type_id is null or e.service_type_id = p_service)
      and (e.starts_at at time zone tz)::date between d_from and d_to
  ),
  cand as (
    select distinct g as cs, g + dur as ce
    from windows w
    cross join lateral generate_series(w.ws, w.we - dur, step) g
  )
  select c.cs, c.ce,
         case when exists (
                select 1 from agenda.bookings b
                where b.status in ('pendente','confirmado')
                  and tstzrange(b.starts_at - buf, b.ends_at + buf, '[)') && tstzrange(c.cs, c.ce, '[)')
              ) then 'reservado' else 'disponivel' end
  from cand c
  where c.cs >= earliest
    and not exists (
      select 1 from agenda.time_blocks t
      where (t.modality is null or t.modality = p_modality)
        and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(c.cs, c.ce, '[)'))
    and not exists (
      select 1 from agenda.external_busy x
      where tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(c.cs, c.ce, '[)'))
  order by 1;
end $$;

-- ---------------------------------------------------------------------
-- PÚBLICO: configuração da agenda
-- ---------------------------------------------------------------------
create or replace function public.site_get_public_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'slug', t.slug, 'name', t.name, 'description', t.description,
               'duration_min', t.duration_min,
               'allow_presencial', t.allow_presencial, 'allow_online', t.allow_online)
             order by t.sort_order, t.name)
      from agenda.service_types t where t.active and t.public_booking), '[]'::jsonb),
    'settings', (
      select jsonb_build_object(
               'timezone', s.timezone, 'max_days_ahead', s.max_days_ahead,
               'min_notice_hours', s.min_notice_hours, 'auto_confirm', s.auto_confirm,
               'instructions_presencial', s.instructions_presencial,
               'instructions_online', s.instructions_online,
               'email_confirmation', (select i.google_connected and i.send_emails from agenda.integration i where i.id))
      from agenda.settings s where s.id)
  );
$$;

-- ---------------------------------------------------------------------
-- PÚBLICO: horários (somente início/fim/situação — nenhum dado pessoal)
-- ---------------------------------------------------------------------
create or replace function public.site_get_slots(
  p_service uuid, p_modality text, p_from date, p_to date
) returns table (starts_at timestamptz, ends_at timestamptz, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Intervalo de datas inválido.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from agenda.service_types t
                 where t.id = p_service and t.active and t.public_booking) then
    return;
  end if;
  return query select * from agenda.compute_slots(p_service, p_modality, p_from, p_to);
end $$;

-- ---------------------------------------------------------------------
-- PÚBLICO: criar agendamento (transação atômica, sem conflitos)
-- ---------------------------------------------------------------------
create or replace function public.site_create_booking(
  p_service   uuid,
  p_modality  text,
  p_starts_at timestamptz,
  p_full_name text,
  p_email     text,
  p_phone     text,
  p_note      text    default null,
  p_consent   boolean default false,
  p_hp        text    default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s       agenda.settings;
  st      agenda.service_types;
  v_name  text := btrim(regexp_replace(coalesce(p_full_name,''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(coalesce(p_email,'')));
  v_phone text := btrim(regexp_replace(coalesce(p_phone,''), '[^0-9+() -]', '', 'g'));
  v_note  text := nullif(btrim(coalesce(p_note,'')), '');
  v_slot  record;
  b       agenda.bookings;
  tz      text;
begin
  if coalesce(p_hp, '') <> '' then
    raise exception 'Não foi possível concluir a solicitação.' using errcode = 'P0001';
  end if;
  if not coalesce(p_consent, false) then
    raise exception 'Para agendar, é preciso concordar com a Política de Privacidade.' using errcode = 'P0001';
  end if;
  if length(v_name) < 3 or length(v_name) > 120 then
    raise exception 'Informe seu nome completo.' using errcode = 'P0001';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 160 then
    raise exception 'Informe um e-mail válido.' using errcode = 'P0001';
  end if;
  if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 10 or length(v_phone) > 30 then
    raise exception 'Informe um telefone/WhatsApp válido, com DDD.' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 400 then
    raise exception 'A observação deve ter no máximo 400 caracteres.' using errcode = 'P0001';
  end if;

  -- Serializa agendamentos simultâneos
  perform pg_advisory_xact_lock(hashtext('agenda.bookings'));

  select * into s from agenda.settings where id;
  tz := s.timezone;

  select * into st from agenda.service_types t
  where t.id = p_service and t.active and t.public_booking;
  if not found then
    raise exception 'Tipo de atendimento indisponível.' using errcode = 'P0001';
  end if;

  if (select count(*) from agenda.bookings
      where source = 'site' and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Muitas solicitações no momento. Tente novamente em alguns minutos.' using errcode = 'P0001';
  end if;

  if (select count(*) from agenda.bookings
      where lower(email) = v_email and status in ('pendente','confirmado')
        and starts_at > now()) >= s.max_active_per_email then
    raise exception 'Você já possui agendamentos ativos. Para novos horários, entre em contato.' using errcode = 'P0001';
  end if;

  select * into v_slot
  from agenda.compute_slots(p_service, p_modality,
                            (p_starts_at at time zone tz)::date,
                            (p_starts_at at time zone tz)::date) c
  where c.starts_at = p_starts_at;

  if not found or v_slot.status <> 'disponivel' then
    raise exception 'Este horário não está mais disponível. Por favor, escolha outro.' using errcode = 'P0001';
  end if;

  begin
    insert into agenda.bookings (service_type_id, modality, starts_at, ends_at, status,
                                 full_name, email, phone, patient_note, source, consent_at)
    values (st.id, p_modality, v_slot.starts_at, v_slot.ends_at,
            case when s.auto_confirm then 'confirmado' else 'pendente' end,
            v_name, v_email, v_phone, v_note, 'site', now())
    returning * into b;
  exception when exclusion_violation then
    raise exception 'Este horário acabou de ser reservado. Por favor, escolha outro.' using errcode = 'P0001';
  end;

  return jsonb_build_object(
    'code', b.code, 'status', b.status,
    'starts_at', b.starts_at, 'ends_at', b.ends_at,
    'modality', b.modality, 'service', st.name,
    'cancel_token', b.cancel_token,
    'instructions', case when b.modality = 'online' then s.instructions_online else s.instructions_presencial end
  );
end $$;

-- ---------------------------------------------------------------------
-- PÚBLICO: consultar / cancelar pelo link seguro
-- ---------------------------------------------------------------------
create or replace function public.site_get_booking(p_code text, p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'code', b.code, 'status', b.status, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
    'modality', b.modality, 'service', t.name,
    'first_name', split_part(b.full_name, ' ', 1),
    'can_cancel', b.status in ('pendente','confirmado') and b.starts_at > now())
  from agenda.bookings b join agenda.service_types t on t.id = b.service_type_id
  where b.code = upper(btrim(p_code)) and b.cancel_token = p_token and b.anonymized_at is null;
$$;

create or replace function public.site_cancel_booking(p_code text, p_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b agenda.bookings;
begin
  update agenda.bookings
     set status = 'cancelado', cancelled_at = now(), cancelled_by = 'paciente'
   where code = upper(btrim(p_code)) and cancel_token = p_token
     and status in ('pendente','confirmado') and starts_at > now()
  returning * into b;
  if not found then
    raise exception 'Não foi possível cancelar este agendamento.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('code', b.code, 'status', b.status);
end $$;

-- ---------------------------------------------------------------------
-- ADMIN
-- ---------------------------------------------------------------------
create or replace function public.site_admin_check() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('is_admin', agenda.is_admin());
$$;

create or replace function public.site_admin_bootstrap() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform agenda.require_admin();
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from agenda.settings s where s.id),
    'integration', (select jsonb_build_object(
        'google_client_id', i.google_client_id,
        'google_client_secret_set', exists(select 1 from vault.secrets v where v.name = 'agenda_google_client_secret'),
        'google_connected', i.google_connected, 'google_email', i.google_email,
        'google_calendar_id', i.google_calendar_id, 'send_emails', i.send_emails,
        'last_sync_at', i.last_sync_at, 'last_sync_error', i.last_sync_error,
        'function_url', i.function_url, 'site_url', i.site_url)
      from agenda.integration i where i.id),
    'services', coalesce((select jsonb_agg(to_jsonb(t) order by t.sort_order, t.name) from agenda.service_types t), '[]'),
    'rules', coalesce((select jsonb_agg(to_jsonb(r) order by r.weekday, r.start_time) from agenda.availability_rules r), '[]'),
    'blocks', coalesce((select jsonb_agg(to_jsonb(b) order by b.starts_at) from agenda.time_blocks b
                        where b.ends_at > now() - interval '30 days'), '[]'),
    'extras', coalesce((select jsonb_agg(to_jsonb(e) order by e.starts_at) from agenda.extra_slots e
                        where e.ends_at > now() - interval '30 days'), '[]'),
    'admins', coalesce((select jsonb_agg(a.email order by a.email) from agenda.admins a), '[]')
  );
end $$;

create or replace function public.site_admin_bookings(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform agenda.require_admin();
  if p_to - p_from > interval '400 days' then
    raise exception 'Período muito longo.' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'service_type_id', b.service_type_id, 'service', t.name,
      'modality', b.modality, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'status', b.status,
      'full_name', b.full_name, 'email', b.email, 'phone', b.phone,
      'patient_note', b.patient_note, 'internal_note', b.internal_note, 'source', b.source,
      'gcal_event_id', b.gcal_event_id, 'email_sent_at', b.email_sent_at, 'sync_error', b.sync_error,
      'created_at', b.created_at, 'cancelled_at', b.cancelled_at, 'cancelled_by', b.cancelled_by)
      order by b.starts_at)
    from agenda.bookings b join agenda.service_types t on t.id = b.service_type_id
    where b.starts_at < p_to and b.ends_at > p_from), '[]'::jsonb);
end $$;

create or replace function public.site_admin_save_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id    uuid := nullif(p->>'id','')::uuid;
  st      agenda.service_types;
  v_start timestamptz := (p->>'starts_at')::timestamptz;
  v_end   timestamptz := nullif(p->>'ends_at','')::timestamptz;
  b       agenda.bookings;
begin
  perform agenda.require_admin();
  select * into st from agenda.service_types where id = (p->>'service_type_id')::uuid;
  if not found then raise exception 'Selecione o tipo de atendimento.' using errcode = 'P0001'; end if;
  if v_start is null then raise exception 'Informe data e horário.' using errcode = 'P0001'; end if;
  v_end := coalesce(v_end, v_start + make_interval(mins => st.duration_min));

  begin
    if v_id is null then
      insert into agenda.bookings (service_type_id, modality, starts_at, ends_at, status,
                                   full_name, email, phone, patient_note, internal_note, source)
      values (st.id, p->>'modality', v_start, v_end, coalesce(nullif(p->>'status',''), 'confirmado'),
              btrim(p->>'full_name'), lower(btrim(p->>'email')), btrim(p->>'phone'),
              nullif(btrim(coalesce(p->>'patient_note','')),''), nullif(btrim(coalesce(p->>'internal_note','')),''), 'admin')
      returning * into b;
    else
      update agenda.bookings set
        service_type_id = st.id,
        modality        = p->>'modality',
        starts_at       = v_start,
        ends_at         = v_end,
        status          = coalesce(nullif(p->>'status',''), status),
        full_name       = btrim(p->>'full_name'),
        email           = lower(btrim(p->>'email')),
        phone           = btrim(p->>'phone'),
        patient_note    = nullif(btrim(coalesce(p->>'patient_note','')),''),
        internal_note   = nullif(btrim(coalesce(p->>'internal_note','')),''),
        cancelled_at    = case when coalesce(p->>'status', status) = 'cancelado' and cancelled_at is null then now()
                               when coalesce(p->>'status', status) <> 'cancelado' then null else cancelled_at end,
        cancelled_by    = case when coalesce(p->>'status', status) = 'cancelado' then coalesce(cancelled_by, 'admin') else null end
      where id = v_id
      returning * into b;
      if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0001'; end if;
    end if;
  exception
    when exclusion_violation then
      raise exception 'Conflito: já existe um atendimento ativo nesse horário.' using errcode = 'P0001';
    when check_violation then
      raise exception 'Verifique os dados: nome (mín. 3 letras), e-mail válido, telefone e horário de término posterior ao início.' using errcode = 'P0001';
  end;
  return to_jsonb(b) - 'cancel_token';
end $$;

create or replace function public.site_admin_set_booking_status(p_id uuid, p_status text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b agenda.bookings;
begin
  perform agenda.require_admin();
  if p_status not in ('pendente','confirmado','cancelado','concluido','faltou') then
    raise exception 'Situação inválida.' using errcode = 'P0001';
  end if;
  begin
    update agenda.bookings set
      status = p_status,
      cancelled_at = case when p_status = 'cancelado' then coalesce(cancelled_at, now()) else null end,
      cancelled_by = case when p_status = 'cancelado' then coalesce(cancelled_by, 'admin') else null end
    where id = p_id returning * into b;
  exception when exclusion_violation then
    raise exception 'Conflito: o horário já está ocupado por outro atendimento.' using errcode = 'P0001';
  end;
  if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0001'; end if;
  return to_jsonb(b) - 'cancel_token';
end $$;

-- Salvar entidades de configuração
create or replace function public.site_admin_save(p_entity text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id  uuid := nullif(p->>'id','')::uuid;
  res   jsonb;
begin
  perform agenda.require_admin();

  if p_entity = 'service_type' then
    if v_id is null then
      insert into agenda.service_types (slug, name, description, duration_min, allow_presencial, allow_online,
                                        public_booking, active, sort_order)
      values (p->>'slug', p->>'name', nullif(p->>'description',''), (p->>'duration_min')::int,
              coalesce((p->>'allow_presencial')::boolean, true), coalesce((p->>'allow_online')::boolean, true),
              coalesce((p->>'public_booking')::boolean, true), coalesce((p->>'active')::boolean, true),
              coalesce((p->>'sort_order')::int, 0))
      returning to_jsonb(service_types.*) into res;
    else
      update agenda.service_types set
        slug = p->>'slug', name = p->>'name', description = nullif(p->>'description',''),
        duration_min = (p->>'duration_min')::int,
        allow_presencial = coalesce((p->>'allow_presencial')::boolean, true),
        allow_online = coalesce((p->>'allow_online')::boolean, true),
        public_booking = coalesce((p->>'public_booking')::boolean, true),
        active = coalesce((p->>'active')::boolean, true),
        sort_order = coalesce((p->>'sort_order')::int, 0)
      where id = v_id returning to_jsonb(service_types.*) into res;
    end if;

  elsif p_entity = 'rule' then
    if v_id is null then
      insert into agenda.availability_rules (weekday, start_time, end_time, modality, service_type_id,
                                             valid_from, valid_until, active, note)
      values ((p->>'weekday')::smallint, (p->>'start_time')::time, (p->>'end_time')::time,
              coalesce(p->>'modality','ambas'), nullif(p->>'service_type_id','')::uuid,
              nullif(p->>'valid_from','')::date, nullif(p->>'valid_until','')::date,
              coalesce((p->>'active')::boolean, true), nullif(p->>'note',''))
      returning to_jsonb(availability_rules.*) into res;
    else
      update agenda.availability_rules set
        weekday = (p->>'weekday')::smallint, start_time = (p->>'start_time')::time, end_time = (p->>'end_time')::time,
        modality = coalesce(p->>'modality','ambas'), service_type_id = nullif(p->>'service_type_id','')::uuid,
        valid_from = nullif(p->>'valid_from','')::date, valid_until = nullif(p->>'valid_until','')::date,
        active = coalesce((p->>'active')::boolean, true), note = nullif(p->>'note','')
      where id = v_id returning to_jsonb(availability_rules.*) into res;
    end if;

  elsif p_entity = 'block' then
    if v_id is null then
      insert into agenda.time_blocks (starts_at, ends_at, kind, modality, reason)
      values ((p->>'starts_at')::timestamptz, (p->>'ends_at')::timestamptz, coalesce(p->>'kind','bloqueio'),
              nullif(p->>'modality',''), nullif(p->>'reason',''))
      returning to_jsonb(time_blocks.*) into res;
    else
      update agenda.time_blocks set
        starts_at = (p->>'starts_at')::timestamptz, ends_at = (p->>'ends_at')::timestamptz,
        kind = coalesce(p->>'kind','bloqueio'), modality = nullif(p->>'modality',''), reason = nullif(p->>'reason','')
      where id = v_id returning to_jsonb(time_blocks.*) into res;
    end if;

  elsif p_entity = 'extra' then
    if v_id is null then
      insert into agenda.extra_slots (starts_at, ends_at, modality, service_type_id, note)
      values ((p->>'starts_at')::timestamptz, (p->>'ends_at')::timestamptz, coalesce(p->>'modality','ambas'),
              nullif(p->>'service_type_id','')::uuid, nullif(p->>'note',''))
      returning to_jsonb(extra_slots.*) into res;
    else
      update agenda.extra_slots set
        starts_at = (p->>'starts_at')::timestamptz, ends_at = (p->>'ends_at')::timestamptz,
        modality = coalesce(p->>'modality','ambas'), service_type_id = nullif(p->>'service_type_id','')::uuid,
        note = nullif(p->>'note','')
      where id = v_id returning to_jsonb(extra_slots.*) into res;
    end if;

  elsif p_entity = 'settings' then
    update agenda.settings set
      slot_step_min        = coalesce((p->>'slot_step_min')::int, slot_step_min),
      min_notice_hours     = coalesce((p->>'min_notice_hours')::int, min_notice_hours),
      max_days_ahead       = coalesce((p->>'max_days_ahead')::int, max_days_ahead),
      buffer_min           = coalesce((p->>'buffer_min')::int, buffer_min),
      auto_confirm         = coalesce((p->>'auto_confirm')::boolean, auto_confirm),
      max_active_per_email = coalesce((p->>'max_active_per_email')::int, max_active_per_email),
      instructions_presencial = coalesce(p->>'instructions_presencial', instructions_presencial),
      instructions_online     = coalesce(p->>'instructions_online', instructions_online)
    where id returning to_jsonb(settings.*) into res;

  elsif p_entity = 'integration' then
    update agenda.integration set
      google_calendar_id = coalesce(nullif(btrim(p->>'google_calendar_id'),''), google_calendar_id),
      send_emails        = coalesce((p->>'send_emails')::boolean, send_emails),
      site_url           = coalesce(nullif(btrim(p->>'site_url'),''), site_url)
    where id returning jsonb_build_object('ok', true) into res;

  else
    raise exception 'Entidade inválida.' using errcode = 'P0001';
  end if;

  if res is null then raise exception 'Registro não encontrado.' using errcode = 'P0001'; end if;
  return res;
exception
  when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception 'Verifique os campos preenchidos (horários, datas e valores).' using errcode = 'P0001';
  when unique_violation then
    raise exception 'Já existe um registro com esse identificador.' using errcode = 'P0001';
end $$;

create or replace function public.site_admin_delete(p_entity text, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform agenda.require_admin();
  if p_entity = 'rule' then
    delete from agenda.availability_rules where id = p_id;
  elsif p_entity = 'block' then
    delete from agenda.time_blocks where id = p_id;
  elsif p_entity = 'extra' then
    delete from agenda.extra_slots where id = p_id;
  elsif p_entity = 'service_type' then
    if exists (select 1 from agenda.bookings where service_type_id = p_id) then
      update agenda.service_types set active = false where id = p_id;
      return jsonb_build_object('deactivated', true);
    end if;
    delete from agenda.service_types where id = p_id;
  else
    raise exception 'Entidade inválida.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.site_admin_admins(p_action text, p_email text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email,'')));
begin
  perform agenda.require_admin();
  if p_action = 'add' then
    if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'E-mail inválido.' using errcode = 'P0001';
    end if;
    insert into agenda.admins (email) values (v_email) on conflict do nothing;
  elsif p_action = 'remove' then
    if v_email = 'hermelanyantunes@gmail.com' then
      raise exception 'A conta principal não pode ser removida.' using errcode = 'P0001';
    end if;
    delete from agenda.admins where email = v_email;
  else
    raise exception 'Ação inválida.' using errcode = 'P0001';
  end if;
  return coalesce((select jsonb_agg(email order by email) from agenda.admins), '[]');
end $$;

-- Credenciais OAuth do Google (o segredo vai para o Vault, criptografado)
create or replace function public.site_admin_set_google_client(p_client_id text, p_client_secret text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform agenda.require_admin();
  if coalesce(btrim(p_client_id),'') !~ '\.apps\.googleusercontent\.com$' then
    raise exception 'O Client ID deve terminar com .apps.googleusercontent.com' using errcode = 'P0001';
  end if;
  update agenda.integration set google_client_id = btrim(p_client_id) where id;
  if coalesce(btrim(p_client_secret),'') <> '' then
    select id into v_id from vault.secrets where name = 'agenda_google_client_secret';
    if v_id is null then
      perform vault.create_secret(btrim(p_client_secret), 'agenda_google_client_secret', 'Google OAuth client secret (agenda do site)');
    else
      perform vault.update_secret(v_id, btrim(p_client_secret));
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- LGPD: anonimização de agendamentos antigos
create or replace function public.site_admin_anonymize(p_months int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform agenda.require_admin();
  if p_months is null or p_months < 1 then
    raise exception 'Informe o número de meses.' using errcode = 'P0001';
  end if;
  update agenda.bookings set
    full_name = 'Registro anonimizado', email = 'anonimizado@exemplo.invalid', phone = '0000000000',
    patient_note = null, internal_note = null, anonymized_at = now()
  where anonymized_at is null and ends_at < now() - make_interval(months => p_months);
  get diagnostics n = row_count;
  return jsonb_build_object('anonymized', n);
end $$;

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
revoke all on function agenda.is_admin()                                  from public, anon, authenticated;
revoke all on function agenda.require_admin()                             from public, anon, authenticated;
revoke all on function agenda.compute_slots(uuid, text, date, date)       from public, anon, authenticated;
revoke all on function agenda.touch_updated_at()                          from public, anon, authenticated;

revoke all on function public.site_get_public_config()                                                     from public;
revoke all on function public.site_get_slots(uuid, text, date, date)                                       from public;
revoke all on function public.site_create_booking(uuid, text, timestamptz, text, text, text, text, boolean, text) from public;
revoke all on function public.site_get_booking(text, uuid)                                                 from public;
revoke all on function public.site_cancel_booking(text, uuid)                                              from public;
grant execute on function public.site_get_public_config()                                                  to anon, authenticated;
grant execute on function public.site_get_slots(uuid, text, date, date)                                    to anon, authenticated;
grant execute on function public.site_create_booking(uuid, text, timestamptz, text, text, text, text, boolean, text) to anon, authenticated;
grant execute on function public.site_get_booking(text, uuid)                                              to anon, authenticated;
grant execute on function public.site_cancel_booking(text, uuid)                                           to anon, authenticated;

revoke all on function public.site_admin_check()                             from public, anon;
revoke all on function public.site_admin_bootstrap()                         from public, anon;
revoke all on function public.site_admin_bookings(timestamptz, timestamptz)  from public, anon;
revoke all on function public.site_admin_save_booking(jsonb)                 from public, anon;
revoke all on function public.site_admin_set_booking_status(uuid, text)      from public, anon;
revoke all on function public.site_admin_save(text, jsonb)                   from public, anon;
revoke all on function public.site_admin_delete(text, uuid)                  from public, anon;
revoke all on function public.site_admin_admins(text, text)                  from public, anon;
revoke all on function public.site_admin_set_google_client(text, text)       from public, anon;
revoke all on function public.site_admin_anonymize(int)                      from public, anon;
grant execute on function public.site_admin_check()                             to authenticated;
grant execute on function public.site_admin_bootstrap()                         to authenticated;
grant execute on function public.site_admin_bookings(timestamptz, timestamptz)  to authenticated;
grant execute on function public.site_admin_save_booking(jsonb)                 to authenticated;
grant execute on function public.site_admin_set_booking_status(uuid, text)      to authenticated;
grant execute on function public.site_admin_save(text, jsonb)                   to authenticated;
grant execute on function public.site_admin_delete(text, uuid)                  to authenticated;
grant execute on function public.site_admin_admins(text, text)                  to authenticated;
grant execute on function public.site_admin_set_google_client(text, text)       to authenticated;
grant execute on function public.site_admin_anonymize(int)                      to authenticated;
