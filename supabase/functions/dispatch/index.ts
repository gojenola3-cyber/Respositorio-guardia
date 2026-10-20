// Edge Function "dispatch": activa emergencias y envía/reenvía/cancela avisos.
//
//   POST /functions/v1/dispatch   (Authorization: Bearer <JWT del usuario>)
//     { "action": "activate", "params": { ...argumentos de create_emergency } }
//     { "action": "resend",   "emergencyId": "...", "recipientIds": ["..."]? }
//     { "action": "cancel",   "emergencyId": "...", "reason": "..."? }
//     { "action": "test" }    -> notificación de prueba a mis dispositivos
//
//   POST /functions/v1/dispatch   (x-cron-secret: <CRON_SECRET>)
//     { "action": "sweep" }   -> recordatorios + recibos (cada minuto)
//
// Los permisos NO se comprueban aquí: cada acción de usuario llama primero a
// una RPC con el JWT del usuario y es PostgreSQL quien decide (RLS + RPC).
// Solo después se usa la clave de servicio para leer dispositivos y registrar
// envíos.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { sendToRecipients, sweep, type RecipientStatus, type Store } from '../_shared/dispatch.ts';
import { buildMessage, expoClient } from '../_shared/expo.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const push = expoClient({ accessToken: Deno.env.get('EXPO_ACCESS_TOKEN') ?? null });
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] ?? ''),
    'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });

const STATUS_BY_SQLSTATE: Record<string, number> = { '42501': 403, P0002: 404, '22023': 400, P0001: 409 };

function rpcError(req: Request, error: { code?: string; message?: string }) {
  // Solo se devuelve la clave del error, nunca detalles internos.
  return json(req, STATUS_BY_SQLSTATE[error.code ?? ''] ?? 500, {
    error: STATUS_BY_SQLSTATE[error.code ?? ''] ? error.message : 'internal_error',
  });
}

function timingSafeEqual(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Almacén sobre Supabase (service_role) ---------------------------------
function supabaseStore(db: SupabaseClient): Store {
  const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message);
    return r.data as T;
  };
  return {
    async getEmergency(id) {
      type Row = { id: string; org_id: string; title: string; address: string | null; priority: 'low' | 'medium' | 'high' | 'critical'; status: 'active' | 'closed' | 'cancelled' };
      const e = must<Row | null>(await db.from('emergencies').select('id, org_id, title, address, priority, status').eq('id', id).maybeSingle());
      if (!e) return null;
      const s = must<{ critical_alerts_enabled: boolean } | null>(await db.from('organization_settings').select('critical_alerts_enabled').eq('org_id', e.org_id).maybeSingle());
      return {
        id: e.id, orgId: e.org_id, title: e.title, address: e.address, priority: e.priority, status: e.status,
        criticalAlertsEnabled: Boolean(s?.critical_alerts_enabled),
      };
    },
    async getTargets(emergencyId, statuses: RecipientStatus[], recipientIds) {
      let q = db.from('emergency_recipients')
        .select('id, member_id, status, notify_attempts, last_notified_at')
        .eq('emergency_id', emergencyId).in('status', statuses);
      if (recipientIds) q = q.in('id', recipientIds);
      const recipients = must(await q) as { id: string; member_id: string; status: RecipientStatus; notify_attempts: number; last_notified_at: string | null }[];
      if (!recipients.length) return [];
      const members = must(await db.from('organization_members').select('id, user_id').in('id', recipients.map((r) => r.member_id))) as { id: string; user_id: string }[];
      const userOf = new Map(members.map((m) => [m.id, m.user_id]));
      const tokens = must(await db.from('push_tokens').select('id, user_id, token')
        .in('user_id', [...new Set(members.map((m) => m.user_id))]).is('revoked_at', null)) as { id: string; user_id: string; token: string }[];
      return recipients.map((r) => ({
        recipientId: r.id,
        status: r.status,
        attempts: r.notify_attempts,
        lastNotifiedAt: r.last_notified_at,
        tokens: tokens.filter((t) => t.user_id === userOf.get(r.member_id)).map((t) => ({ id: t.id, token: t.token })),
      }));
    },
    async getCancellationNotified(emergencyId) {
      const rows = must(await db.from('notification_deliveries').select('recipient_id')
        .eq('emergency_id', emergencyId).eq('kind', 'cancellation')) as { recipient_id: string }[];
      return new Set(rows.map((r) => r.recipient_id));
    },
    async insertDeliveries(rows) {
      if (!rows.length) return;
      must(await db.from('notification_deliveries').insert(rows.map((d) => ({
        org_id: d.orgId, emergency_id: d.emergencyId, recipient_id: d.recipientId, push_token_id: d.pushTokenId,
        channel: 'expo_push', kind: d.kind, attempt: d.attempt, status: d.status,
        provider_ticket_id: d.providerTicketId, error_code: d.errorCode, error_message: d.errorMessage,
      }))));
    },
    async markNotified(ids, succeeded, at) {
      must(await db.rpc('record_notification_attempts', {
        p_recipients: ids, p_succeeded: [...succeeded], p_at: at.toISOString(),
      }));
    },
    async revokeTokens(ids, reason) {
      must(await db.from('push_tokens').update({ revoked_at: new Date().toISOString(), revoked_reason: reason }).in('id', ids));
    },
    async getPendingReceipts(olderThan, limit) {
      const rows = must(await db.from('notification_deliveries').select('id, provider_ticket_id, push_token_id')
        .eq('status', 'provider_accepted').not('provider_ticket_id', 'is', null)
        .lt('created_at', olderThan.toISOString())
        .gt('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
        .order('created_at').limit(limit)) as { id: string; provider_ticket_id: string; push_token_id: string | null }[];
      return rows.map((r) => ({ deliveryId: r.id, ticketId: r.provider_ticket_id, pushTokenId: r.push_token_id }));
    },
    async updateDelivery(id, status, errorCode, errorMessage) {
      must(await db.from('notification_deliveries').update({
        status, error_code: errorCode, error_message: errorMessage, receipt_checked_at: new Date().toISOString(),
      }).eq('id', id));
    },
    async touchReceipts(ids, at) {
      must(await db.from('notification_deliveries').update({ receipt_checked_at: at.toISOString() }).in('id', ids));
    },
    async getActiveEmergencies() {
      const rows = must(await db.from('emergencies').select('id, org_id').eq('status', 'active')) as { id: string; org_id: string }[];
      if (!rows.length) return [];
      const settings = must(await db.from('organization_settings').select('org_id, resend_interval_seconds, max_resends')
        .in('org_id', [...new Set(rows.map((r) => r.org_id))])) as { org_id: string; resend_interval_seconds: number; max_resends: number }[];
      const byOrg = new Map(settings.map((s) => [s.org_id, s]));
      return rows.map((r) => ({
        id: r.id,
        resendIntervalSeconds: byOrg.get(r.org_id)?.resend_interval_seconds ?? 120,
        maxResends: byOrg.get(r.org_id)?.max_resends ?? 3,
      }));
    },
  };
}

const store = supabaseStore(admin);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'method_not_allowed' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: 'invalid_input' });
  }

  try {
    if (body.action === 'sweep') {
      if (!timingSafeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) {
        return json(req, 401, { error: 'not_authenticated' });
      }
      return json(req, 200, await sweep({ store, push }));
    }

    const authorization = req.headers.get('Authorization');
    if (!authorization) return json(req, 401, { error: 'not_authenticated' });
    // Cliente con la identidad del usuario: la base de datos aplica sus permisos.
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });

    switch (body.action) {
      case 'activate': {
        const { data: emergencyId, error } = await asUser.rpc('create_emergency', body.params as Record<string, unknown>);
        if (error) return rpcError(req, error);
        // La emergencia ya existe: aunque el envío falle se devuelve su id para
        // que el panel la muestre. Los avisos no enviados los reintenta "sweep".
        try {
          return json(req, 200, { emergencyId, delivery: await sendToRecipients({ store, push, emergencyId, kind: 'alert' }) });
        } catch (err) {
          console.error('dispatch_send_failed', err instanceof Error ? err.message : 'unknown');
          return json(req, 200, { emergencyId, delivery: null, deliveryError: 'dispatch_failed' });
        }
      }
      case 'resend': {
        const { data: ids, error } = await asUser.rpc('request_resend', {
          p_emergency: body.emergencyId, p_recipients: body.recipientIds ?? null,
        });
        if (error) return rpcError(req, error);
        const result = (ids as string[]).length
          ? await sendToRecipients({ store, push, emergencyId: String(body.emergencyId), kind: 'reminder', recipientIds: ids as string[] })
          : null;
        return json(req, 200, { delivery: result });
      }
      case 'cancel': {
        const { error } = await asUser.rpc('cancel_emergency', { p_emergency: body.emergencyId, p_reason: body.reason ?? null });
        if (error) return rpcError(req, error);
        const result = await sendToRecipients({ store, push, emergencyId: String(body.emergencyId), kind: 'cancellation' });
        return json(req, 200, { delivery: result });
      }
      case 'test': {
        const { data: user, error } = await asUser.auth.getUser();
        if (error || !user?.user) return json(req, 401, { error: 'not_authenticated' });
        const { data: tokens } = await admin.from('push_tokens').select('token').eq('user_id', user.user.id).is('revoked_at', null);
        if (!tokens?.length) return json(req, 200, { tickets: [], error: 'no_device' });
        const messages = tokens.map((t: { token: string }) => ({
          ...buildMessage('alert', t.token, { emergencyId: 'test', recipientId: 'test', title: 'Prueba de aviso', address: null, priorityLabel: 'prueba', critical: false }),
          data: { type: 'test' },
        }));
        return json(req, 200, { tickets: await push.send(messages) });
      }
      default:
        return json(req, 400, { error: 'invalid_input' });
    }
  } catch (err) {
    // Sin tokens, coordenadas ni datos personales en el registro.
    console.error('dispatch_error', body.action, err instanceof Error ? err.message : 'unknown');
    return json(req, 502, { error: 'dispatch_failed' });
  }
});
