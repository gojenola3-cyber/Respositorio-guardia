import 'server-only';
import type { MemberRole } from '@guardia/core';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { createClient } from './supabase/server';

export interface Membership {
  id: string;
  org_id: string;
  role: MemberRole;
  org: { name: string; slug: string };
}

/**
 * Usuario y membresía activa. Si tiene varias organizaciones se usa la
 * elegida (cookie "org") o la primera. Es una comprobación de interfaz: la
 * autorización real la hace PostgreSQL en cada consulta.
 */
export async function requireMembership(roles?: MemberRole[]) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('organization_members')
    .select('id, org_id, role, organizations(name, slug)')
    .eq('user_id', user.id)
    .eq('status', 'active');
  const memberships: Membership[] = (data ?? []).map((m: any) => ({
    id: m.id, org_id: m.org_id, role: m.role, org: m.organizations,
  }));
  if (!memberships.length) redirect('/alta');

  const preferred = (await cookies()).get('org')?.value;
  const current = memberships.find((m) => m.org_id === preferred) ?? memberships[0]!;
  if (roles && !roles.includes(current.role)) redirect('/sin-permiso');
  return { supabase, user, membership: current, memberships };
}
