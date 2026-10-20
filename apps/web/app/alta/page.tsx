'use client';
import { errorMessage } from '@guardia/core';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { supabaseBrowser } from '@/lib/supabase/client';

/** Alta en una organización: aceptar invitación, solicitar acceso o crear una nueva. */
function Onboarding() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const supabase = supabaseBrowser();

  async function run(fn: () => PromiseLike<{ error: unknown }>, ok: string, go?: string) {
    setMsg(null);
    const { error } = await fn();
    if (error) return setMsg({ ok: false, text: errorMessage('es', error) });
    setMsg({ ok: true, text: ok });
    if (go) {
      router.replace(go);
      router.refresh();
    }
  }

  return (
    <main className="main" style={{ maxWidth: 620, margin: '6vh auto' }}>
      <h1>Unirse a una organización</h1>
      {msg && <p className={msg.ok ? 'notice' : 'notice notice-danger'} role="status">{msg.text}</p>}

      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        const t = String(new FormData(e.currentTarget).get('token')).trim();
        run(() => supabase.rpc('accept_invitation', { p_token: t }), 'Invitación aceptada.', '/');
      }}>
        <h2>Tengo una invitación</h2>
        <label>Código de invitación<input name="token" defaultValue={token ?? ''} required autoComplete="off" /></label>
        <button className="btn btn-primary">Aceptar invitación</button>
      </form>

      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        const slug = String(new FormData(e.currentTarget).get('slug')).trim();
        run(() => supabase.rpc('request_membership', { p_slug: slug }),
          'Solicitud enviada. Un administrador tiene que aprobarla.');
      }}>
        <h2>Solicitar acceso</h2>
        <label>Identificador de la organización<span className="hint"> (te lo da tu responsable)</span>
          <input name="slug" required pattern="[a-z0-9-]+" autoComplete="off" /></label>
        <button className="btn">Solicitar</button>
      </form>

      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(() => supabase.rpc('create_organization', { p_name: String(f.get('name')), p_slug: String(f.get('slug')) }),
          'Organización creada. Eres su administrador.', '/configuracion');
      }}>
        <h2>Crear una organización nueva</h2>
        <label>Nombre<input name="name" required minLength={2} /></label>
        <label>Identificador<span className="hint"> (minúsculas, números y guiones)</span>
          <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]" /></label>
        <button className="btn">Crear</button>
      </form>
    </main>
  );
}

export default function Page() {
  return <Suspense><Onboarding /></Suspense>;
}
