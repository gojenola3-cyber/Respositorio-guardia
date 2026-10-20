import { Nav } from '@/components/Nav';
import { OrgProvider } from '@/components/OrgContext';
import { requireMembership } from '@/lib/session';

// Todo el panel exige sesión y rol de responsable o admin (comprobado en
// servidor). Aun así, cada dato lo filtra la RLS de PostgreSQL.
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const { membership } = await requireMembership(['admin', 'responsable']);
  return (
    <div className="shell">
      <Nav isAdmin={membership.role === 'admin'} orgName={membership.org.name} />
      <div className="main">
        <OrgProvider value={{ orgId: membership.org_id, memberId: membership.id, role: membership.role, orgName: membership.org.name }}>
          {children}
        </OrgProvider>
      </div>
    </div>
  );
}
