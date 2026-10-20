// Orquestación del envío de alertas: decide a quién enviar, registra cada
// intento y su resultado, y actualiza el estado de cada destinatario.
// La persistencia va detrás de la interfaz Store (Supabase en producción,
// memoria en los tests).
import {
  buildMessage,
  chunk,
  MAX_MESSAGES_PER_REQUEST,
  MAX_RECEIPTS_PER_REQUEST,
  type ExpoMessage,
  type ExpoTicket,
  type MessageKind,
  type PushClient,
} from './expo.ts';

export type DeliveryStatus =
  | 'queued'
  | 'provider_accepted'
  | 'provider_error'
  | 'platform_accepted'
  | 'platform_error'
  | 'no_token';

export type RecipientStatus =
  | 'pending_send' | 'sent' | 'opened' | 'accepted' | 'declined' | 'en_route' | 'arrived' | 'cancelled';

export interface EmergencyInfo {
  id: string;
  orgId: string;
  title: string;
  address: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'active' | 'closed' | 'cancelled';
  criticalAlertsEnabled: boolean;
}

export interface Target {
  recipientId: string;
  status: RecipientStatus;
  attempts: number;
  lastNotifiedAt: string | null;
  tokens: { id: string; token: string }[];
}

export interface NewDelivery {
  orgId: string;
  emergencyId: string;
  recipientId: string;
  pushTokenId: string | null;
  kind: MessageKind;
  attempt: number;
  status: DeliveryStatus;
  providerTicketId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PendingReceipt {
  deliveryId: string;
  ticketId: string;
  pushTokenId: string | null;
}

export interface Store {
  getEmergency(id: string): Promise<EmergencyInfo | null>;
  getTargets(emergencyId: string, statuses: RecipientStatus[], recipientIds?: string[]): Promise<Target[]>;
  /** Recipientes ya avisados de la cancelación (para no repetir). */
  getCancellationNotified(emergencyId: string): Promise<Set<string>>;
  insertDeliveries(rows: NewDelivery[]): Promise<void>;
  /** Suma un intento; si hubo éxito y seguía "pending_send", pasa a "sent". */
  markNotified(recipientIds: string[], succeeded: Set<string>, at: Date): Promise<void>;
  revokeTokens(tokenIds: string[], reason: string): Promise<void>;
  getPendingReceipts(olderThan: Date, limit: number): Promise<PendingReceipt[]>;
  updateDelivery(id: string, status: DeliveryStatus, errorCode: string | null, errorMessage: string | null): Promise<void>;
  touchReceipts(ids: string[], at: Date): Promise<void>;
  getActiveEmergencies(): Promise<{ id: string; resendIntervalSeconds: number; maxResends: number }[]>;
}

const PRIORITY_LABEL = { low: 'baja', medium: 'media', high: 'alta', critical: 'crítica' } as const;

// Errores de APNs/FCM que indican que el token ya no sirve.
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered']);

export interface SendResult {
  targets: number;
  messages: number;
  accepted: number;
  failed: number;
  noDevice: number;
  /** Personas a las que no ha llegado ningún aviso: llamar por teléfono. */
  unreachableRecipientIds: string[];
}

const AWAITING: RecipientStatus[] = ['pending_send', 'sent', 'opened'];

export async function sendToRecipients(opts: {
  store: Store;
  push: PushClient;
  emergencyId: string;
  kind: MessageKind;
  recipientIds?: string[];
  now?: Date;
}): Promise<SendResult> {
  const { store, push, emergencyId, kind } = opts;
  const now = opts.now ?? new Date();
  const result: SendResult = { targets: 0, messages: 0, accepted: 0, failed: 0, noDevice: 0, unreachableRecipientIds: [] };

  const emergency = await store.getEmergency(emergencyId);
  if (!emergency) return result;
  if (kind === 'cancellation' ? emergency.status !== 'cancelled' : emergency.status !== 'active') return result;

  let targets = await store.getTargets(emergencyId, kind === 'cancellation' ? ['cancelled'] : AWAITING, opts.recipientIds);
  if (kind === 'alert') {
    // El envío inicial solo a quien aún no ha recibido ningún intento: si la
    // activación se repite (doble pulsación, reintento), no se duplica.
    targets = targets.filter((t) => t.attempts === 0 && t.status === 'pending_send');
  }
  if (kind === 'cancellation') {
    const done = await store.getCancellationNotified(emergencyId);
    targets = targets.filter((t) => !done.has(t.recipientId));
  }
  result.targets = targets.length;
  if (!targets.length) return result;

  const deliveries: NewDelivery[] = [];
  const base = (t: Target) => ({
    orgId: emergency.orgId,
    emergencyId,
    recipientId: t.recipientId,
    kind,
    attempt: t.attempts + 1,
  });

  const outgoing: { target: Target; tokenId: string; message: ExpoMessage }[] = [];
  for (const t of targets) {
    if (!t.tokens.length) {
      result.noDevice++;
      deliveries.push({
        ...base(t), pushTokenId: null, status: 'no_token',
        providerTicketId: null, errorCode: 'no_device', errorMessage: 'Sin dispositivo registrado',
      });
      continue;
    }
    for (const tok of t.tokens) {
      outgoing.push({
        target: t,
        tokenId: tok.id,
        message: buildMessage(kind, tok.token, {
          emergencyId,
          recipientId: t.recipientId,
          title: emergency.title,
          address: emergency.address,
          priorityLabel: PRIORITY_LABEL[emergency.priority],
          critical: emergency.criticalAlertsEnabled && emergency.priority === 'critical',
        }),
      });
    }
  }

  const succeeded = new Set<string>();
  const deadTokens: string[] = [];
  for (const batch of chunk(outgoing, MAX_MESSAGES_PER_REQUEST)) {
    let tickets: ExpoTicket[] | null = null;
    let batchError: string | null = null;
    try {
      tickets = await push.send(batch.map((b) => b.message));
      if (tickets.length !== batch.length) batchError = 'ticket_count_mismatch';
    } catch (err) {
      batchError = err instanceof Error ? err.message.slice(0, 80) : 'network';
    }
    result.messages += batch.length;

    batch.forEach((b, i) => {
      const ticket = batchError ? null : tickets![i]!;
      if (ticket && ticket.status === 'ok') {
        result.accepted++;
        succeeded.add(b.target.recipientId);
        deliveries.push({
          ...base(b.target), pushTokenId: b.tokenId, status: 'provider_accepted',
          providerTicketId: ticket.id, errorCode: null, errorMessage: null,
        });
      } else {
        result.failed++;
        const code = ticket?.status === 'error' ? ticket.details?.error ?? 'provider_error' : batchError ?? 'provider_error';
        if (DEAD_TOKEN_ERRORS.has(code)) deadTokens.push(b.tokenId);
        deliveries.push({
          ...base(b.target), pushTokenId: b.tokenId, status: 'provider_error', providerTicketId: null,
          errorCode: code.slice(0, 80),
          errorMessage: (ticket?.status === 'error' ? ticket.message : batchError)?.slice(0, 500) ?? null,
        });
      }
    });
  }

  await store.insertDeliveries(deliveries);
  if (kind !== 'cancellation') {
    await store.markNotified(targets.map((t) => t.recipientId), succeeded, now);
  }
  if (deadTokens.length) await store.revokeTokens(deadTokens, 'DeviceNotRegistered');
  result.unreachableRecipientIds = targets.filter((t) => !succeeded.has(t.recipientId)).map((t) => t.recipientId);
  return result;
}

/**
 * Comprueba los recibos de Expo: confirman que APNs/FCM aceptó el mensaje
 * (o lo rechazó). Siguen sin confirmar que el móvil lo mostrara.
 */
export async function checkReceipts(opts: { store: Store; push: PushClient; now?: Date }) {
  const now = opts.now ?? new Date();
  // Expo recomienda esperar antes de pedir recibos; con 1 min suelen estar.
  const pending = await opts.store.getPendingReceipts(new Date(now.getTime() - 60_000), MAX_RECEIPTS_PER_REQUEST);
  const stats = { checked: pending.length, ok: 0, error: 0, missing: 0 };
  if (!pending.length) return stats;

  const receipts = await opts.push.getReceipts(pending.map((p) => p.ticketId));
  const dead: string[] = [];
  const untouched: string[] = [];
  for (const p of pending) {
    const r = receipts[p.ticketId];
    if (!r) {
      stats.missing++;
      untouched.push(p.deliveryId);
    } else if (r.status === 'ok') {
      stats.ok++;
      await opts.store.updateDelivery(p.deliveryId, 'platform_accepted', null, null);
    } else {
      stats.error++;
      const code = r.details?.error ?? 'platform_error';
      if (DEAD_TOKEN_ERRORS.has(code) && p.pushTokenId) dead.push(p.pushTokenId);
      await opts.store.updateDelivery(p.deliveryId, 'platform_error', code.slice(0, 80), r.message?.slice(0, 500) ?? null);
    }
  }
  if (untouched.length) await opts.store.touchReceipts(untouched, now);
  if (dead.length) await opts.store.revokeTokens(dead, 'DeviceNotRegistered');
  return stats;
}

/** Recordatorios automáticos a quien sigue sin contestar. */
export function dueForReminder(t: Target, intervalSeconds: number, maxResends: number, now: Date): boolean {
  if (!AWAITING.includes(t.status)) return false;
  if (t.attempts === 0) return true; // nunca se le pudo enviar: reintentar ya
  if (t.attempts > maxResends) return false;
  if (!t.lastNotifiedAt) return true;
  return now.getTime() - new Date(t.lastNotifiedAt).getTime() >= intervalSeconds * 1000;
}

export async function sweep(opts: { store: Store; push: PushClient; now?: Date }) {
  const now = opts.now ?? new Date();
  const summary = { emergencies: 0, reminders: 0, receipts: null as Awaited<ReturnType<typeof checkReceipts>> | null };
  for (const e of await opts.store.getActiveEmergencies()) {
    summary.emergencies++;
    const targets = await opts.store.getTargets(e.id, AWAITING);
    const due = targets.filter((t) => dueForReminder(t, e.resendIntervalSeconds, e.maxResends, now));
    if (!due.length) continue;
    const firstTry = due.filter((t) => t.attempts === 0).map((t) => t.recipientId);
    const reminders = due.filter((t) => t.attempts > 0).map((t) => t.recipientId);
    if (firstTry.length) {
      await sendToRecipients({ ...opts, emergencyId: e.id, kind: 'alert', recipientIds: firstTry, now });
    }
    if (reminders.length) {
      const r = await sendToRecipients({ ...opts, emergencyId: e.id, kind: 'reminder', recipientIds: reminders, now });
      summary.reminders += r.targets;
    }
  }
  summary.receipts = await checkReceipts(opts);
  return summary;
}
