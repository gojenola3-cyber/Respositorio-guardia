import { RECIPIENT_TONE, recipientLabel, type RecipientStatus } from '@guardia/core';

const ICON: Record<string, string> = {
  'clock-alert': '⏳', send: '📤', eye: '👁', 'check-circle': '✅', 'x-circle': '✖', navigation: '🧭',
  'map-pin-check': '📍', ban: '⛔',
};

/** Estado con color, icono y texto: nunca solo color. */
export function StatusBadge({ status }: { status: RecipientStatus }) {
  const { tone, icon } = RECIPIENT_TONE[status];
  return (
    <span className={`badge tone-${tone}`}>
      <span aria-hidden>{ICON[icon]}</span>
      {recipientLabel('es', status)}
    </span>
  );
}
