// Estados del dominio. Deben coincidir con los tipos enumerados de la base de
// datos (supabase/migrations/20261020000100_schema.sql).

export const MEMBER_ROLES = ['admin', 'responsable', 'voluntario'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ['pending', 'active', 'suspended', 'deactivated'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const SHIFT_STATUSES = ['open', 'full', 'closed', 'cancelled'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const EVENT_TYPES = ['service', 'practice', 'training', 'meeting', 'event', 'maintenance', 'other'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type AgendaKind = EventType | 'shift';

export const EMERGENCY_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type EmergencyPriority = (typeof EMERGENCY_PRIORITIES)[number];

export const RECIPIENT_STATUSES = [
  'pending_send',
  'sent',
  'opened',
  'accepted',
  'declined',
  'en_route',
  'arrived',
  'cancelled',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'queued',
  'provider_accepted',
  'provider_error',
  'platform_accepted',
  'platform_error',
  'no_token',
  'manual_contact',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const isManagerRole = (role: MemberRole): boolean => role === 'admin' || role === 'responsable';

/** Sin respuesta todavía (pendiente de envío, enviada o abierta). */
export const isAwaitingResponse = (s: RecipientStatus): boolean =>
  s === 'pending_send' || s === 'sent' || s === 'opened';

/** Acude: aceptada, en camino o ya en la base. */
export const isComing = (s: RecipientStatus): boolean => s === 'accepted' || s === 'en_route' || s === 'arrived';

/** Solo estos estados admiten seguimiento GPS. */
export const allowsTracking = (s: RecipientStatus): boolean => s === 'accepted' || s === 'en_route';

/**
 * Tono visual de cada estado. La interfaz nunca depende solo del color:
 * cada tono va con un icono y un texto.
 */
export type Tone = 'danger' | 'success' | 'warning' | 'info' | 'neutral';

export const RECIPIENT_TONE: Record<RecipientStatus, { tone: Tone; icon: string }> = {
  pending_send: { tone: 'warning', icon: 'clock-alert' },
  sent: { tone: 'warning', icon: 'send' },
  opened: { tone: 'warning', icon: 'eye' },
  accepted: { tone: 'success', icon: 'check-circle' },
  declined: { tone: 'neutral', icon: 'x-circle' },
  en_route: { tone: 'info', icon: 'navigation' },
  arrived: { tone: 'success', icon: 'map-pin-check' },
  cancelled: { tone: 'neutral', icon: 'ban' },
};

export type RecipientCounts = Record<RecipientStatus, number> & { total: number };

export function countRecipients(statuses: readonly RecipientStatus[]): RecipientCounts {
  const counts = Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0])) as RecipientCounts;
  counts.total = statuses.length;
  for (const s of statuses) counts[s]++;
  return counts;
}

/** Resumen que pide el panel: sí, no, pendientes, en camino, en base. */
export function summarize(counts: RecipientCounts) {
  return {
    total: counts.total,
    yes: counts.accepted + counts.en_route + counts.arrived,
    no: counts.declined,
    pending: counts.pending_send + counts.sent + counts.opened,
    enRoute: counts.en_route,
    arrived: counts.arrived,
    cancelled: counts.cancelled,
  };
}
