import { requireMembership } from '@/lib/session';

import { Settings } from './Settings';

// Solo administradores (y la RLS solo deja escribir a admins).
export default async function SettingsPage() {
  await requireMembership(['admin']);
  return <Settings />;
}
