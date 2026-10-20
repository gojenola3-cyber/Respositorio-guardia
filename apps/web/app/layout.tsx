import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Guardia · Panel',
  description: 'Gestión de guardias y activación de emergencias',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
