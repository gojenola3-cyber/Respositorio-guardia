// Borrador de activación: validación en cliente para avisar antes de enviar.
// El servidor vuelve a validarlo todo (create_emergency).
import { isValidLatLng, type LatLng } from './geo.ts';
import type { EmergencyPriority } from './status.ts';

export interface EmergencyDraft {
  /** Se genera al abrir el formulario y se reutiliza en cada reintento. */
  idempotencyKey: string;
  title: string;
  type?: string;
  description?: string;
  address?: string;
  location?: LatLng | null;
  priority: EmergencyPriority;
  baseId?: string | null;
  requiredQualificationIds: string[];
  notes?: string;
}

export type DraftError = 'title' | 'location' | 'recipients';

export function newDraft(idempotencyKey: string): EmergencyDraft {
  return { idempotencyKey, title: '', priority: 'high', requiredQualificationIds: [], location: null };
}

export function validateDraft(draft: EmergencyDraft, recipientCount: number): DraftError[] {
  const errors: DraftError[] = [];
  if (draft.title.trim().length < 2) errors.push('title');
  if (draft.location != null && !isValidLatLng(draft.location)) errors.push('location');
  if (recipientCount < 1) errors.push('recipients');
  return errors;
}

/** Parámetros de la RPC create_emergency (sin destinatarios). */
export function draftToRpc(orgId: string, d: EmergencyDraft) {
  return {
    p_org: orgId,
    p_idempotency_key: d.idempotencyKey,
    p_title: d.title.trim(),
    p_type: d.type?.trim() || null,
    p_description: d.description?.trim() || null,
    p_address: d.address?.trim() || null,
    p_lat: d.location?.lat ?? null,
    p_lng: d.location?.lng ?? null,
    p_priority: d.priority,
    p_base: d.baseId ?? null,
    p_notes: d.notes?.trim() || null,
    p_required_qualifications: d.requiredQualificationIds,
  };
}

/** Texto breve para la pantalla de confirmación. */
export function confirmationSummary(d: EmergencyDraft, recipients: number) {
  return {
    title: d.title.trim(),
    where: d.address?.trim() || (d.location ? `${d.location.lat.toFixed(5)}, ${d.location.lng.toFixed(5)}` : null),
    recipients,
    priority: d.priority,
  };
}
