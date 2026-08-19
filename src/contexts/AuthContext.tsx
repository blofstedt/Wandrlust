import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { TrustTier } from '../types';

/**
 * Authentication and profile state.
 *
 * Everything in migrations 02–08 keys off `auth.uid()` — presence, points,
 * tiers, push. Without a session those RLS policies all evaluate against null
 * and the features are inert. This context is the foundation the rest of the
 * platform sits on.
 */

export interface Profile {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  trust_score: number;
  trust_tier: TrustTier;
  default_visibility: 'ghost' | 'friends' | 'public';
  check_in_count: number;
  scout_count: number;
  verify_count: number;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  pointsBalance: number;
  isLoading: boolean;
  isConfigured: boolean;
  error: string | null;

  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string) => Promise<{ ok: boolean; message: string }>;
  signInWithPassword: (email: string, password: string) => Promise<{ ok: boolean; message: string }>;
  signUpWithPassword: (email: string, password: string) => Promise<{ ok: boolean; message: string }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => Promise<{ ok: boolean; message: string }>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pointsBalance, setPointsBalance] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Load the profile row, creating it if the signup trigger hasn't fired.
   * Belt and braces: a missing trigger shouldn't strand a user with no row.
   */
  const loadProfile = useCallback(async (currentUser: User) => {
    if (!supabase) return;

    const { data, error: selectError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .maybeSingle();

    if (selectError) {
      setError(selectError.message);
      return;
    }

    if (data) {
      setProfile(data as Profile);
    } else {
      const base =
        (currentUser.email?.split('@')[0] ?? 'camper')
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '')
          .slice(0, 16) || 'camper';
      const handle = `${base}_${currentUser.id.slice(0, 6)}`;

      const { data: created, error: insertError } = await supabase
        .from('profiles')
        .insert({
          id: currentUser.id,
          handle,
          display_name:
            currentUser.user_metadata?.full_name ?? currentUser.user_metadata?.name ?? null,
          avatar_url: currentUser.user_metadata?.avatar_url ?? null
        })
        .select()
        .single();

      if (insertError) setError(insertError.message);
      else setProfile(created as Profile);
    }

    // Balance is derived from the append-only ledger.
    const { data: balance } = await supabase.rpc('points_balance', { in_user: currentUser.id });
    setPointsBalance(typeof balance === 'number' ? balance : 0);
  }, []);

  // Bootstrap: read any existing session, then subscribe to changes.
  useEffect(() => {
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        loadProfile(data.session.user).finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      if (newSession?.user) {
        loadProfile(newSession.user);
      } else {
        setProfile(null);
        setPointsBalance(0);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return;
    setError(null);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { access_type: 'offline', prompt: 'consent' }
      }
    });
    if (oauthError) setError(oauthError.message);
  }, []);

  /** Passwordless magic link. */
  const signInWithEmail = useCallback(async (email: string) => {
    if (!supabase) return { ok: false, message: 'Supabase not configured' };
    setError(null);
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
    });
    if (otpError) return { ok: false, message: otpError.message };
    return { ok: true, message: 'Check your email for a sign-in link.' };
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    if (!supabase) return { ok: false, message: 'Supabase not configured' };
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) return { ok: false, message: signInError.message };
    return { ok: true, message: 'Signed in.' };
  }, []);

  const signUpWithPassword = useCallback(async (email: string, password: string) => {
    if (!supabase) return { ok: false, message: 'Supabase not configured' };
    setError(null);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
    });
    if (signUpError) return { ok: false, message: signUpError.message };
    if (data.session) return { ok: true, message: 'Account created.' };
    return { ok: true, message: 'Check your email to confirm your account.' };
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setProfile(null);
    setPointsBalance(0);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) await loadProfile(user);
  }, [user, loadProfile]);

  const updateProfile = useCallback(
    async (patch: Partial<Profile>) => {
      if (!supabase || !user) return { ok: false, message: 'Not signed in' };

      // Trust columns are stripped server-side by the protect_trust_columns
      // trigger; we omit them here so the intent is obvious in the client too.
      const {
        trust_score: _s,
        trust_tier: _t,
        check_in_count: _c,
        scout_count: _sc,
        verify_count: _v,
        ...safe
      } = patch as any;

      const { error: updateError } = await supabase
        .from('profiles')
        .update(safe)
        .eq('id', user.id);

      if (updateError) return { ok: false, message: updateError.message };
      await refreshProfile();
      return { ok: true, message: 'Profile updated.' };
    },
    [user, refreshProfile]
  );

  /**
   * Memoised because every consumer of useAuth() re-renders whenever this
   * object's identity changes, and a fresh object literal on every provider
   * render means that is every render — the map included, which is the
   * single most expensive thing in the app to re-render for no reason.
   */
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      profile,
      pointsBalance,
      isLoading,
      isConfigured: isSupabaseConfigured,
      error,
      signInWithGoogle,
      signInWithEmail,
      signInWithPassword,
      signUpWithPassword,
      signOut,
      refreshProfile,
      updateProfile
    }),
    [
      user, session, profile, pointsBalance, isLoading, error,
      signInWithGoogle, signInWithEmail, signInWithPassword,
      signUpWithPassword, signOut, refreshProfile, updateProfile
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
