-- =====================================================================
-- Sincronização automática com o Google Agenda
--   * gatilho: cada criação/alteração de agendamento chama a Edge Function
--   * pg_cron: a cada 15 min lê os compromissos ocupados do Google Agenda
-- Só faz chamadas quando a integração está conectada.
-- =====================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function agenda.chamar_funcao(p_rota text, p_corpo jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i agenda.integration;
  k text;
begin
  select * into i from agenda.integration where id;
  if not coalesce(i.google_connected, false) then return; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name = 'agenda_internal_key';
  perform net.http_post(
    url := rtrim(i.function_url, '/') || p_rota,
    body := p_corpo,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-agenda-key', k),
    timeout_milliseconds := 15000
  );
end $$;

create or replace function agenda.notificar_agendamento() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform agenda.chamar_funcao('/sync-booking', jsonb_build_object('booking_id', new.id));
  return new;
end $$;

drop trigger if exists bookings_sync on agenda.bookings;
create trigger bookings_sync
  after insert or update of status, starts_at, ends_at, modality, service_type_id, full_name, email, phone, patient_note
  on agenda.bookings
  for each row execute function agenda.notificar_agendamento();

revoke all on function agenda.chamar_funcao(text, jsonb) from public, anon, authenticated;
revoke all on function agenda.notificar_agendamento() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'site-agenda-google-sync';
select cron.schedule('site-agenda-google-sync', '*/15 * * * *',
  $cron$ select agenda.chamar_funcao('/sync-all', '{}'::jsonb) $cron$);
