# Auth setup — Google + Email

Three stages: Google Cloud, then Supabase, then your `.env`. About 15 minutes.
Do them in order — you'll bounce between the two consoles once.

---

## Before you start

Get your Supabase project ref from the dashboard URL:

```
https://supabase.com/dashboard/project/abcdefghijklmnop
                                       ^^^^^^^^^^^^^^^^ this is your ref
```

Your callback URL will be:

```
https://<your-project-ref>.supabase.co/auth/v1/callback
```

Keep that handy — Google Cloud asks for it.

---

## Stage 1 — Google Cloud

### 1.1 Create the project

1. <https://console.cloud.google.com/>
2. Project dropdown → **New Project**
3. Name it `Wandrlust` → **Create**
4. Make sure the project selector shows **Wandrlust** before continuing

### 1.2 Configure the consent screen

Must exist before you can create credentials.

1. **APIs & Services → OAuth consent screen**
2. User type: **External** → **Create**
3. Fill in app name, support email, developer contact
4. **Save and Continue**
5. **Scopes** — add only:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`

   Don't add more. Extra scopes trigger Google's verification review, which
   takes weeks and you don't need any of it.
6. **Save and Continue** → **Back to Dashboard**

> In **Testing** mode only accounts you add under **Test users** can sign in,
> capped at 100. Fine for development. Publishing with only the three scopes
> above does not require review.

### 1.3 Create the OAuth client

1. **Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. **Authorised JavaScript origins**:
   ```
   http://localhost:3000
   ```
   Plus your production origin when you have one.
4. **Authorised redirect URIs** — your Supabase callback:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```

   This trips everyone up: the redirect URI is **Supabase's** domain, not
   yours. Google sends the user to Supabase, and Supabase sends them back to
   you. Putting your own URL here gives `redirect_uri_mismatch`.
5. **Create**, then copy the **Client ID** and **Client secret**

---

## Stage 2 — Supabase

### 2.1 Enable Google

**Authentication → Providers → Google** → toggle on → paste Client ID and
Secret → **Save**.

### 2.2 Enable Email

**Authentication → Providers → Email** → toggle on.

- **Confirm email** — ON for production, OFF during development so you're not
  round-tripping an inbox on every test signup.
- **Secure email change** — leave ON.

Both sign-in styles work off this one provider: magic link uses
`signInWithOtp`, password uses `signInWithPassword`.

### 2.3 Set the redirect URLs

**Authentication → URL Configuration**

- **Site URL**: `http://localhost:3000`
- **Redirect URLs** — add both:
  ```
  http://localhost:3000/auth/callback
  https://your-production-domain.com/auth/callback
  ```

Supabase rejects any redirect not on this allowlist, which shows up as a
successful Google login that dumps the user on a blank page.

### 2.4 Auto-create profiles on signup

The app creates a missing profile as a fallback, but a trigger is more
reliable. Run in the **SQL Editor**:

```sql
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, handle, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_]', '', 'g'),
      'camper'
    ) || '_' || substr(new.id::text, 1, 6),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

---

## Stage 3 — Your `.env`

**Project Settings → API** gives you both values:

```bash
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...   # the "anon public" key
```

Restart the dev server — Vite only reads env vars at startup.

**The anon key is meant to be public** — it ships in your JS bundle. All
security comes from RLS. The key you must never expose is `service_role`.

---

## Verify

1. Open <http://localhost:3000> → **Sign in** → **Continue with Google**
2. The button becomes an avatar with a tier trophy and points balance
3. Check the database:

```sql
select id, email, created_at from auth.users order by created_at desc limit 5;
select id, handle, trust_tier, trust_score from public.profiles;
```

A new user should be `tourist` with score 0. That's correct — trust is earned.

---

## When it doesn't work

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` | Google's redirect URI must be the **Supabase** callback, not your app URL |
| Login succeeds, blank page | `/auth/callback` missing from Supabase → URL Configuration |
| "Authentication isn't configured" | `.env` not read — restart the dev server |
| Magic link never arrives | Supabase's built-in SMTP is heavily rate-limited. Configure custom SMTP |
| `Database error saving new user` | The `handle_new_user` trigger failed — check Logs → Postgres |
| Signed in but data hidden | Expected. RLS gates on trust tier; a new account is `tourist` |

---

## Production checklist

- [ ] Production origin added to Google **Authorised JavaScript origins**
- [ ] `https://yourdomain.com/auth/callback` in Supabase **Redirect URLs**
- [ ] **Site URL** changed off localhost
- [ ] **Confirm email** turned back ON
- [ ] Custom SMTP configured
- [ ] Google consent screen published
- [ ] `service_role` key absent from anything client-side
