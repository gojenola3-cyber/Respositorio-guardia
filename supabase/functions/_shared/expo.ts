// Cliente y formato de mensajes de Expo Push (https://docs.expo.dev/push-notifications/sending-notifications/).
// Sin dependencias: corre igual en Deno (Edge Function) y en Node (tests).

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
export const MAX_MESSAGES_PER_REQUEST = 100;
export const MAX_RECEIPTS_PER_REQUEST = 1000;

export const ANDROID_CHANNEL_ALERTS = 'emergency-alerts';
export const ANDROID_CHANNEL_UPDATES = 'emergency-updates';
export const IOS_CATEGORY_RESPONSE = 'emergency_response';
export const ALERT_SOUND = 'emergency.wav';

export type MessageKind = 'alert' | 'reminder' | 'cancellation' | 'test';

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound?: 'default' | string | { critical: boolean; name: string; volume: number } | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
  categoryId?: string;
  interruptionLevel?: 'active' | 'critical' | 'passive' | 'time-sensitive';
  ttl?: number;
}

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

export type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

export const isExpoPushToken = (token: string) =>
  /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(token);

export interface AlertContent {
  emergencyId: string;
  recipientId: string;
  title: string;
  address?: string | null;
  priorityLabel: string;
  /** Solo con el entitlement de Apple concedido (organization_settings). */
  critical: boolean;
}

export function buildMessage(kind: MessageKind, token: string, c: AlertContent): ExpoMessage {
  const data = { type: kind === 'cancellation' ? 'emergency_cancelled' : 'emergency_alert', emergencyId: c.emergencyId, recipientId: c.recipientId };
  if (kind === 'cancellation') {
    return {
      to: token,
      title: 'Emergencia cancelada',
      body: `${c.title}. No es necesario acudir.`,
      data,
      sound: 'default',
      priority: 'high',
      channelId: ANDROID_CHANNEL_UPDATES,
      interruptionLevel: 'active',
      ttl: 3600,
    };
  }
  return {
    to: token,
    title: `${kind === 'reminder' ? 'RECORDATORIO · ' : ''}EMERGENCIA ${c.priorityLabel.toUpperCase()} · ${c.title}`,
    body: c.address ? `${c.address}. ¿Acudes? Responde en la app.` : '¿Acudes? Responde en la app.',
    data,
    // Las alertas críticas suenan aunque el iPhone esté en silencio, pero
    // exigen aprobación expresa de Apple. Sin ella: "time-sensitive".
    sound: c.critical ? { critical: true, name: ALERT_SOUND, volume: 1 } : ALERT_SOUND,
    priority: 'high',
    channelId: ANDROID_CHANNEL_ALERTS,
    categoryId: IOS_CATEGORY_RESPONSE,
    interruptionLevel: c.critical ? 'critical' : 'time-sensitive',
    // Una alerta de hace más de 15 minutos ya no sirve: mejor no entregarla.
    ttl: 900,
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class PushHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PushClient {
  send(messages: ExpoMessage[]): Promise<ExpoTicket[]>;
  getReceipts(ids: string[]): Promise<Record<string, ExpoReceipt>>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cliente HTTP de Expo con reintentos ante errores de red, 429 y 5xx.
 * accessToken: necesario si se activa "Enhanced security for push" en Expo.
 */
export function expoClient(opts: {
  fetch?: typeof fetch;
  accessToken?: string | null;
  retries?: number;
  backoffMs?: number;
} = {}): PushClient {
  const doFetch = opts.fetch ?? fetch;
  const retries = opts.retries ?? 2;
  const backoff = opts.backoffMs ?? 400;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
  };

  async function post<T>(url: string, body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoff * 2 ** (attempt - 1));
      try {
        const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (res.status === 429 || res.status >= 500) {
          lastError = new PushHttpError(res.status, `HTTP ${res.status}`);
          continue;
        }
        const json = (await res.json()) as { data?: T; errors?: { code?: string; message?: string }[] };
        if (!res.ok || json.errors?.length || json.data === undefined) {
          // Error de la petición entera (p. ej. credenciales): no se reintenta.
          throw new PushHttpError(res.status, json.errors?.[0]?.code ?? json.errors?.[0]?.message ?? `HTTP ${res.status}`);
        }
        return json.data;
      } catch (err) {
        if (err instanceof PushHttpError && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    send: (messages) => post<ExpoTicket[]>(EXPO_SEND_URL, messages),
    getReceipts: (ids) => post<Record<string, ExpoReceipt>>(EXPO_RECEIPTS_URL, { ids }),
  };
}
