'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Inicio' },
  { href: '/emergencias/nueva', label: '🚨 Activar' },
  { href: '/emergencias', label: 'Emergencias' },
  { href: '/guardias', label: 'Guardias' },
  { href: '/agenda', label: 'Agenda' },
  { href: '/voluntarios', label: 'Voluntarios' },
];
const ADMIN_LINKS = [
  { href: '/auditoria', label: 'Auditoría' },
  { href: '/configuracion', label: 'Configuración' },
];

export function Nav({ isAdmin, orgName }: { isAdmin: boolean; orgName: string }) {
  const path = usePathname();
  const links = isAdmin ? [...LINKS, ...ADMIN_LINKS] : LINKS;
  return (
    <nav className="sidebar" aria-label="Navegación principal">
      <div className="brand">Guardia</div>
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
      <div className="org">{orgName}</div>
    </nav>
  );
}
