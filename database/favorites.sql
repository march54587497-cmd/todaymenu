-- Applied to the hosted todaymenu project via Supabase migrations.
-- Use on a new database; this script intentionally does not replace existing tables.
-- auth.users (1) -> favorites (N); recipe_key identifies JSON-file/generated recipes.
create table public.favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_key text not null check (char_length(recipe_key) between 1 and 512),
  recipe jsonb not null check (
    jsonb_typeof(recipe) = 'object'
    and jsonb_typeof(recipe -> 'name') = 'string'
    and char_length(recipe ->> 'name') between 1 and 200
    and octet_length(recipe::text) <= 65536
  ),
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_key)
);
create index favorites_user_created_idx
  on public.favorites (user_id, created_at desc, recipe_key);
alter table public.favorites enable row level security;
revoke all on table public.favorites from anon, authenticated;
grant select, insert, delete on table public.favorites to authenticated;
create policy favorites_select_own on public.favorites
  for select to authenticated using ((select auth.uid()) = user_id);
create policy favorites_insert_own on public.favorites
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy favorites_delete_own on public.favorites
  for delete to authenticated using ((select auth.uid()) = user_id);
comment on table public.favorites is
  'Per-user recipe bookmarks. Recipe snapshots support JSON-file and generated seasonal recipes; user_id + recipe_key prevents duplicates.';
alter table public.favorites add constraint favorites_recipe_name_required
  check (recipe ? 'name');
