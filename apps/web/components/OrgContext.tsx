'use client';
import type { MemberRole } from '@guardia/core';
import { createContext, useContext } from 'react';

export interface OrgInfo {
  orgId: string;
  memberId: string;
  role: MemberRole;
  orgName: string;
}

const Ctx = createContext<OrgInfo | null>(null);

export function OrgProvider({ value, children }: { value: OrgInfo; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOrg(): OrgInfo {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOrg fuera de OrgProvider');
  return v;
}
