-- Moon Chat schema for Supabase. Run the entire script in SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  public_id text not null unique,
  created_at timestamptz not null default now()
);

create or replace function public.make_moon_id()
returns text language sql volatile as $$
  select 'MC-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 8));
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  nm text;
  new_id text;
begin
  nm := coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Moon User');
  nm := left(nm, 24);
  loop
    new_id := public.make_moon_id();
    exit when not exists (select 1 from public.profiles where public_id = new_id);
  end loop;
  insert into public.profiles(id, display_name, public_id)
  values(new.id, nm, new_id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_moon_chat on auth.users;
create trigger on_auth_user_created_moon_chat
after insert on auth.users
for each row execute procedure public.handle_new_user();

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key(conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);

create or replace function public.is_conversation_member(cid uuid, uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = cid and cm.user_id = uid
  );
$$;

create or replace function public.start_direct_chat(target_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  found_id uuid;
  new_id uuid;
begin
  if me is null then raise exception 'Authentication required'; end if;
  if target_user_id is null or target_user_id = me then raise exception 'Invalid target user'; end if;
  if not exists (select 1 from public.profiles where id = target_user_id) then raise exception 'User not found'; end if;

  select cm1.conversation_id into found_id
  from public.conversation_members cm1
  join public.conversation_members cm2 on cm1.conversation_id = cm2.conversation_id
  where cm1.user_id = me and cm2.user_id = target_user_id
    and (select count(*) from public.conversation_members cm3 where cm3.conversation_id = cm1.conversation_id) = 2
  limit 1;
  if found_id is not null then return found_id; end if;

  insert into public.conversations default values returning id into new_id;
  insert into public.conversation_members(conversation_id,user_id) values(new_id,me),(new_id,target_user_id);
  return new_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Authenticated users can find profiles by Moon ID" on public.profiles;
create policy "Authenticated users can find profiles by Moon ID"
on public.profiles for select to authenticated using (true);
drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile"
on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Members can read their conversations" on public.conversations;
create policy "Members can read their conversations"
on public.conversations for select to authenticated using (public.is_conversation_member(id));
drop policy if exists "Members can read membership" on public.conversation_members;
create policy "Members can read membership"
on public.conversation_members for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists "Members can read messages" on public.messages;
create policy "Members can read messages"
on public.messages for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists "Members can send messages as themselves" on public.messages;
create policy "Members can send messages as themselves"
on public.messages for insert to authenticated with check (
  sender_id = auth.uid() and public.is_conversation_member(conversation_id)
);

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.conversations to authenticated;
grant select on public.conversation_members to authenticated;
grant select, insert on public.messages to authenticated;
grant execute on function public.start_direct_chat(uuid) to authenticated;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;

-- Realtime: in Supabase Dashboard → Database → Replication, enable the messages table.
