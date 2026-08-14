-- ---------------------------------------------------------------------
--  Migration 18 — give a beacon back when nothing was scanned
-- ---------------------------------------------------------------------
--
--  WHAT WAS WRONG
--
--  `claim_beacon_token()` is spent BEFORE the scan runs, which is correct:
--  the quota exists to stop someone firing scans in a loop, and a limit you
--  only apply after doing the work is not a limit.
--
--  But nothing gave it back. When OpenStreetMap could not be reached — no
--  ground swept, no candidates, no answer — the camper was shown:
--
--      "Could not reach OpenStreetMap just now, so nothing was scanned.
--       This did not use up a beacon you can spend later."
--
--  while their allowance had in fact gone from 3 to 2. The sentence was
--  written as a promise and there was no code anywhere that kept it. Three
--  failed scans in a row cost a camper their whole twelve-hour allowance and
--  told them, each time, that it had not.
--
--  This is the function that makes the sentence true.
--
--  WHAT IT REFUNDS, AND WHAT IT DOES NOT
--
--  Only the two cases where NO GROUND WAS ACTUALLY SCANNED: every Overpass
--  mirror refused, or the request ran out of time before a single rung of the
--  radius ladder could start. A scan that ran and found nothing is not a
--  refund — that is a real answer about real ground, and it is the answer
--  Beacon exists to give.
--
--  Safe to run more than once (create or replace), and safe to call twice for
--  one scan: `used_in_window` never goes below zero, so a double refund cannot
--  mint an extra beacon.

create or replace function public.refund_beacon_token()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller     uuid := auth.uid();
  q          public.beacon_quota%rowtype;
  left_after integer;
  -- Must match `claim_beacon_token()`. Two copies of one number is a drift
  -- risk; it is here rather than shared because a constant is cheaper to read
  -- than an extra function call on a hot path, and both are in this file's
  -- sight line.
  cap        constant integer  := 3;
  window_len constant interval := interval '12 hours';
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'remaining', 0);
  end if;

  select * into q from public.beacon_quota where user_id = caller for update;

  -- No row means nothing was ever claimed, so there is nothing to hand back.
  if not found then
    return jsonb_build_object('ok', false, 'remaining', cap);
  end if;

  -- The twelve-hour window rolled over between the claim and the refund. The
  -- allowance has already reset to full; handing one back on top of that would
  -- put the camper above the cap.
  if q.window_start < now() - window_len then
    return jsonb_build_object('ok', false, 'remaining', cap);
  end if;

  update public.beacon_quota
     set used_in_window = greatest(0, q.used_in_window - 1)
   where user_id = caller
  returning used_in_window into left_after;

  return jsonb_build_object(
    'ok', true,
    'remaining', cap - left_after,
    'resets_at', q.window_start + window_len
  );
end;
$$;

grant execute on function public.refund_beacon_token() to authenticated;
