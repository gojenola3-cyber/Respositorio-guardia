import type { AgendaKind } from '@guardia/core';

export const KIND_LABEL: Record<AgendaKind, string> = {
  shift: 'Guardia', service: 'Servicio', practice: 'Práctica', training: 'Formación', meeting: 'Reunión',
  event: 'Evento', maintenance: 'Mantenimiento', other: 'Otro',
};
