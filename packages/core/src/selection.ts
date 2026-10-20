// Selección de destinatarios al activar una emergencia.
// Regla: todos los elegibles empiezan marcados; el responsable decide.

export interface Candidate {
  member_id: string;
  display_name: string;
  eligible: boolean;
  ineligible_reason: 'self' | 'missing_qualifications' | 'not_available' | null;
  on_shift: boolean;
  has_push_device: boolean;
}

export interface Selection {
  selected: ReadonlySet<string>;
  /** Motivos privados de exclusión de personas elegibles desmarcadas. */
  reasons: Readonly<Record<string, string>>;
}

export function initialSelection(candidates: readonly Candidate[]): Selection {
  return { selected: new Set(candidates.filter((c) => c.eligible).map((c) => c.member_id)), reasons: {} };
}

export function toggle(sel: Selection, candidate: Candidate): Selection {
  // Quien activa no se puede seleccionar a sí mismo.
  if (candidate.ineligible_reason === 'self') return sel;
  const selected = new Set(sel.selected);
  const reasons = { ...sel.reasons };
  if (selected.has(candidate.member_id)) {
    selected.delete(candidate.member_id);
  } else {
    selected.add(candidate.member_id);
    delete reasons[candidate.member_id];
  }
  return { selected, reasons };
}

/** "Seleccionar todos" marca a los elegibles; los no elegibles se añaden uno a uno. */
export function selectAllEligible(sel: Selection, candidates: readonly Candidate[]): Selection {
  const selected = new Set(sel.selected);
  for (const c of candidates) if (c.eligible) selected.add(c.member_id);
  return { selected, reasons: {} };
}

export function deselectAll(): Selection {
  return { selected: new Set(), reasons: {} };
}

export function setReason(sel: Selection, memberId: string, reason: string): Selection {
  const reasons = { ...sel.reasons };
  const trimmed = reason.trim().slice(0, 300);
  if (trimmed) reasons[memberId] = trimmed;
  else delete reasons[memberId];
  return { selected: sel.selected, reasons };
}

export function selectionSummary(sel: Selection, candidates: readonly Candidate[]) {
  const chosen = candidates.filter((c) => sel.selected.has(c.member_id));
  return {
    recipients: chosen.length,
    withoutPush: chosen.filter((c) => !c.has_push_device).length,
    ineligibleIncluded: chosen.filter((c) => !c.eligible).length,
    eligibleExcluded: candidates.filter((c) => c.eligible && !sel.selected.has(c.member_id)).length,
  };
}

/** Argumentos para la RPC create_emergency. */
export function selectionPayload(sel: Selection) {
  const recipients = [...sel.selected];
  const reasons = Object.fromEntries(Object.entries(sel.reasons).filter(([id]) => !sel.selected.has(id)));
  return { p_recipients: recipients, p_exclusion_reasons: reasons };
}
