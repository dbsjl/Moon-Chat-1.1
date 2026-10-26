-- Moon Chat: run this extra migration once in Supabase SQL Editor.
-- Creates a private photo bucket, adds image support, and enables realtime for messages.

alter table public.messages add column if not exists image_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-photos', 'chat-photos', false, 8388608, array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict (id) do update set public = false, file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','image/avif'];

drop policy if exists "Chat members can upload their own photos" on storage.objects;
create policy "Chat members can upload their own photos"
on storage.objects for insert to authenticated
with check (bucket_id = 'chat-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Authenticated users can read chat photos" on storage.objects;
create policy "Authenticated users can read chat photos"
on storage.objects for select to authenticated
using (bucket_id = 'chat-photos');

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
exception when undefined_object then
  raise notice 'Publication supabase_realtime was not found; enable messages in Database > Publications in Supabase.';
end $$;

grant select, insert on public.messages to authenticated;
