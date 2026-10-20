import type { MemberRole } from '@guardia/core';
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { supabase } from './supabase';

export interface Membership {
  id: string;
  orgId: string;
  orgName: string;
  role: MemberRole;
  availability: 'available' | 'unavailable';
}

interface Ctx {
  session: Session | null;
  loading: boolean;
  membership: Membership | null;
  pendingRequest: boolean;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Ctx>({ session: null, loading: true, membership: null, pendingRequest: false, refresh: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [pendingRequest, setPending] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadMembership = useCallback(async (s: Session | null) => {
    if (!s) {
      setMembership(null);
      return;
    }
    const { data } = await supabase.from('organization_members')
      .select('id, org_id, role, status, availability, organizations(name)').eq('user_id', s.user.id);
    const active = (data ?? []).find((m: any) => m.status === 'active') as any;
    setPending((data ?? []).some((m: any) => m.status === 'pending'));
    setMembership(active ? {
      id: active.id, orgId: active.org_id, orgName: active.organizations?.name ?? '', role: active.role, availability: active.availability,
    } : null);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadMembership(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      loadMembership(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [loadMembership]);

  const refresh = useCallback(() => loadMembership(session), [loadMembership, session]);
  return <SessionContext.Provider value={{ session, loading, membership, pendingRequest, refresh }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
