// Textos de la interfaz. Castellano completo; euskera preparado con
// recurso al castellano en las claves aún sin traducir.
import type { EmergencyPriority, MemberRole, RecipientStatus } from './status.ts';

export const LOCALES = ['es', 'eu'] as const;
export type Locale = (typeof LOCALES)[number];

const es = {
  'app.name': 'Guardia',
  'app.disclaimer':
    'Herramienta de coordinación interna. No sustituye al 112 ni a los sistemas oficiales de despacho de emergencias.',

  'role.admin': 'Administrador',
  'role.responsable': 'Responsable de guardia',
  'role.voluntario': 'Voluntario',

  'recipient.pending_send': 'Pendiente de envío',
  'recipient.sent': 'Enviada (sin confirmar recepción)',
  'recipient.opened': 'Abierta',
  'recipient.accepted': 'Acude',
  'recipient.declined': 'No acude',
  'recipient.en_route': 'En camino',
  'recipient.arrived': 'En la base',
  'recipient.cancelled': 'Cancelada',

  'priority.low': 'Baja',
  'priority.medium': 'Media',
  'priority.high': 'Alta',
  'priority.critical': 'Crítica',

  'emergency.activate': 'ACTIVAR EMERGENCIA',
  'emergency.accept': 'SÍ, ACUDO',
  'emergency.decline': 'NO PUEDO ACUDIR',
  'emergency.recipients_count': '{count} destinatarios',
  'emergency.confirm_title': '¿Enviar la alerta?',
  'emergency.eta_disclaimer': 'Tiempo orientativo en línea recta, no es la ruta real.',
  'emergency.no_push_warning': '{count} sin app o sin avisos activados: avísales por teléfono.',
  'emergency.delivery_unconfirmed':
    'Enviada al proveedor. No confirma que el móvil la haya recibido: solo lo sabremos cuando la abra.',

  'location.fresh': 'Actualizada',
  'location.stale': 'Desfasada',
  'location.old': 'Antigua',
  'location.consent_title': '¿Compartir tu ubicación hasta llegar a la base?',
  'location.consent_body':
    'Solo la verán los responsables y solo durante esta activación. Se borra al llegar, al cancelar o al cerrar.',
  'location.background_warning':
    'Si bloqueas el móvil o cierras la app, el sistema puede dejar de enviar tu posición.',

  'ineligible.self': 'Eres quien activa',
  'ineligible.missing_qualifications': 'Le falta formación requerida',
  'ineligible.not_available': 'No está de guardia ni disponible',

  'error.forbidden': 'No tienes permiso para esta acción.',
  'error.not_authenticated': 'Tu sesión ha caducado. Vuelve a entrar.',
  'error.not_found': 'No se ha encontrado.',
  'error.invalid_input': 'Revisa los datos introducidos.',
  'error.duplicate_signup': 'Ya estás apuntado.',
  'error.overlapping_shift': 'Ya tienes otra guardia a esa hora.',
  'error.shift_full': 'La guardia está completa.',
  'error.shift_not_open': 'La guardia no admite inscripciones.',
  'error.shift_finished': 'La guardia ya ha terminado.',
  'error.shift_started': 'La guardia ya ha empezado. Avisa al responsable.',
  'error.not_signed_up': 'No estabas apuntado.',
  'error.event_full': 'No quedan plazas.',
  'error.event_not_open': 'El evento no admite inscripciones.',
  'error.no_recipients': 'Selecciona al menos un destinatario.',
  'error.invalid_recipients': 'Algún destinatario ya no es miembro activo.',
  'error.emergency_not_active': 'La emergencia ya está cerrada o cancelada.',
  'error.must_accept_first': 'Primero confirma que acudes.',
  'error.location_not_authorized': 'No has autorizado compartir tu ubicación.',
  'error.stale_location': 'La posición GPS es demasiado antigua.',
  'error.already_arrived': 'Ya constas en la base.',
  'error.invitation_invalid': 'La invitación no es válida o ha caducado.',
  'error.invitation_email_mismatch': 'Esta invitación es para otra dirección de correo.',
  'error.already_member': 'Esa persona ya es miembro.',
  'error.last_admin': 'Debe quedar al menos un administrador.',
  'error.rate_limited': 'Demasiadas peticiones. Espera un momento.',
  'error.network': 'Sin conexión. Se reintentará; si es urgente, llama por teléfono.',
  'error.unknown': 'Algo ha fallado. Inténtalo de nuevo.',
} as const;

export type MessageKey = keyof typeof es;

const eu: Partial<Record<MessageKey, string>> = {
  'app.name': 'Guardia',
  'role.voluntario': 'Boluntarioa',
  'recipient.accepted': 'Badator',
  'recipient.declined': 'Ez dator',
  'emergency.accept': 'BAI, BANOA',
  'emergency.decline': 'EZIN DUT JOAN',
};

const dictionaries: Record<Locale, Partial<Record<MessageKey, string>>> = { es, eu };

export function t(locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = dictionaries[locale][key] ?? es[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

export const roleLabel = (l: Locale, r: MemberRole) => t(l, `role.${r}`);
export const recipientLabel = (l: Locale, s: RecipientStatus) => t(l, `recipient.${s}`);
export const priorityLabel = (l: Locale, p: EmergencyPriority) => t(l, `priority.${p}`);

/** Traduce el error que devuelve el servidor (mensaje-clave de las RPC). */
export function errorMessage(locale: Locale, err: unknown): string {
  const raw =
    typeof err === 'string' ? err : err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
  if (/fetch failed|network|Failed to fetch|timeout/i.test(raw)) return t(locale, 'error.network');
  const key = `error.${raw}` as MessageKey;
  return key in es ? t(locale, key) : t(locale, 'error.unknown');
}

/** Claves sin traducir al euskera (para seguir el avance de la traducción). */
export const missingTranslations = (locale: Locale): MessageKey[] =>
  (Object.keys(es) as MessageKey[]).filter((k) => dictionaries[locale][k] === undefined);
