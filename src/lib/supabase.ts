import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase browser client.
 *
 * The anon key is PUBLIC — it ships in the bundle and is meant to. All
 * security comes from Row Level Security policies. Never put the service_role
 * key here; it bypasses RLS entirely.
 *
 * Supabase is optional. When the env vars are absent the app still runs off
 * the bundled dataset — `isSupabaseConfigured` lets the UI degrade instead of
 * crashing on a null client.
 */

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Required so the OAuth redirect back from Google is picked up.
        detectSessionInUrl: true,
        flowType: 'pkce'
      }
    })
  : null;

/** Throws a clear error instead of a null-pointer deep in a component. */
export const requireSupabase = (): SupabaseClient => {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env'
    );
  }
  return supabase;
};
