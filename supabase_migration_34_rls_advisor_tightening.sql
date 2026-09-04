-- Migration 34 — close the three functions that answered for a camper
-- other than the one asking.
--
-- Supabase's security advisor flags every SECURITY DEFINER function that anon
-- or authenticated may execute. Most of that list is the app's own public API
-- and is fine — the map, the campsite list and the beacon ladder are meant to
-- answer an anonymous browser, and every function that writes already gates on
-- auth.uid().
--
-- Three did not. Each took a user id as an ARGUMENT and trusted it, and
-- `profiles` is world-readable by design (handle, display name, trust tier —
-- no email, no location), so anybody holding the anon key that ships in the
-- JavaScript bundle could list every profile id and then ask:
--
--   points_balance(id)            -> that camper's points balance
--   pending_legal_documents(id)   -> which documents that camper has not signed
--   are_friends(a, b)             -> the whole friendship graph, pair by pair
--
-- No writes, no location, no credentials — but it is other people's business,
-- and none of it was ever meant to be readable that way.
--
-- points_balance and pending_legal_documents now answer only for the caller.
-- The signature keeps its argument so the client needs no change; the argument
-- is now checked rather than obeyed, and service_role (the server key, which
-- has no camper of its own) may still ask about anyone.
--
-- are_friends is an internal helper. Its only caller is nearby_campers, which
-- is SECURITY DEFINER owned by postgres and so keeps its own EXECUTE. Nothing
-- in src/ or server/ calls it, so it simply stops being reachable from a
-- browser.
--
-- Note the three-role revoke. `revoke ... from anon, authenticated` alone does
-- nothing: a function carries an implicit `grant execute to PUBLIC`, both roles
-- inherit it, and revoking a privilege they were never separately granted
-- leaves the inherited one standing. PUBLIC must be named. The proof is the
-- ACL, not this file — a leading `=X/postgres` in proacl IS the PUBLIC grant:
--
--   select proname, proacl from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('points_balance','pending_legal_documents','are_friends');

-- ---------------------------------------------------------------- points_balance

create or replace function public.points_balance(in_user uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(delta), 0)::integer
  from public.points_ledger
  where user_id = in_user
    -- Ask about yourself, or hold the server key. Anyone else gets 0, which is
    -- what an account with no ledger rows reads as anyway.
    and (in_user = auth.uid() or auth.role() = 'service_role');
$$;

revoke execute on function public.points_balance(uuid) from public, anon, authenticated;
grant execute on function public.points_balance(uuid) to authenticated, service_role;

-- ------------------------------------------------------- pending_legal_documents

create or replace function public.pending_legal_documents(in_user uuid)
returns table(document_id bigint, kind legal_doc_kind, version text, summary text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.kind, d.version, d.summary
  from public.legal_documents d
  where d.is_current
    and (in_user = auth.uid() or auth.role() = 'service_role')
    and not exists (
      select 1 from public.legal_acceptances a
      where a.user_id = in_user and a.document_id = d.id
    );
$$;

revoke execute on function public.pending_legal_documents(uuid) from public, anon, authenticated;
grant execute on function public.pending_legal_documents(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------- are_friends

revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;
grant execute on function public.are_friends(uuid, uuid) to service_role;

-- --------------------------------------------------------------- beacon_tier_for
-- Not a definer function, so this is housekeeping rather than a hole: pinning
-- search_path stops a caller's own search_path deciding which `beacon_tier` it
-- means. Every other function in this schema already pins it.

alter function public.beacon_tier_for(integer, integer) set search_path = public, pg_temp;
