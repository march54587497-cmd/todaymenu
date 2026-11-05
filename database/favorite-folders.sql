-- Applied after database/favorites.sql to the hosted todaymenu project.
create table public.favorite_folders (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, name)
);
alter table public.favorite_folders enable row level security;
revoke all on table public.favorite_folders from anon, authenticated;
grant select, insert on table public.favorite_folders to authenticated;
create policy favorite_folders_select_own on public.favorite_folders
  for select to authenticated using ((select auth.uid()) = user_id);
create policy favorite_folders_insert_own on public.favorite_folders
  for insert to authenticated with check ((select auth.uid()) = user_id);
alter table public.favorites add column folder_id uuid;
alter table public.favorites add constraint favorites_owned_folder_fkey
  foreign key (user_id, folder_id) references public.favorite_folders (user_id, id);
create index favorites_user_folder_idx on public.favorites (user_id, folder_id);
grant update (folder_id) on table public.favorites to authenticated;
create policy favorites_update_own_folder on public.favorites
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
comment on table public.favorite_folders is
  'User-owned bookmark folders; the composite foreign key prevents assigning another account folder.';
