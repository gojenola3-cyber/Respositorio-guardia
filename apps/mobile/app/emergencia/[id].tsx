import {
  allowsTracking,
  errorMessage,
  estimateArrival,
  isAwaitingResponse,
  navigationLinks,
  priorityLabel,
  RECIPIENT_TONE,
  recipientLabel,
  t,
  type RecipientStatus,
} from '@guardia/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { LocationSubscription } from 'expo-location';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';

import { startTracking, type TrackingState } from '@/location';
import { supabase } from '@/supabase';
import { colors } from '@/theme';
import { Badge, Button, Card, Muted, Notice, Row, Screen, Title } from '@/ui';

const KEEP_AWAKE_TAG = 'guardia-tracking';

/**
 * Recepción y respuesta a una alerta. El parámetro id es el del destinatario
 * (emergency_recipients.id), el mismo que viaja en la notificación.
 */
export default function EmergencyScreen() {
  const { id, action } = useLocalSearchParams<{ id: string; action?: 'accept' | 'decline' }>();
  const [recipient, setRecipient] = useState<any>(null);
  const [emergency, setEmergency] = useState<any>(null);
  const [base, setBase] = useState<{ name: string; lat: number | null; lng: number | null } | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [tracking, setTracking] = useState<TrackingState>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const watch = useRef<LocationSubscription | null>(null);
  const actionDone = useRef(false);

  const load = useCallback(async () => {
    const { data: r, error } = await supabase.from('emergency_recipients').select('*').eq('id', id).single();
    if (error) return setError(errorMessage('es', error));
    setRecipient(r);
    const { data: e } = await supabase.from('emergencies').select('*').eq('id', r.emergency_id).single();
    setEmergency(e);
    if (e?.base_id) {
      const { data: b } = await supabase.from('bases').select('name, lat, lng').eq('id', e.base_id).single();
      setBase(b);
    }
    const { data: c } = await supabase.rpc('emergency_counts', { p_emergency: r.emergency_id });
    setCounts(c);
    setError(null);
    return { r, e };
  }, [id]);

  const stopWatch = useCallback(() => {
    watch.current?.remove();
    watch.current = null;
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    setTracking({ kind: 'idle' });
  }, []);

  // Al abrir: confirmar que se ha visto (único "recibida" fiable) y, si se
  // pulsó un botón en la notificación, registrar esa respuesta.
  useEffect(() => {
    (async () => {
      const res = await load();
      if (!res || res.e?.status !== 'active') return;
      await supabase.rpc('mark_alert_opened', { p_recipient: id });
      if (action && !actionDone.current && isAwaitingResponse(res.r.status)) {
        actionDone.current = true;
        await respond(action === 'accept');
      } else {
        load();
      }
    })();
    const ch = supabase.channel(`recipient-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'emergency_recipients', filter: `id=eq.${id}` }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
      stopWatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const status = recipient?.status as RecipientStatus | undefined;
  const active = emergency?.status === 'active';

  // El seguimiento solo corre con aceptación + consentimiento + emergencia activa.
  useEffect(() => {
    const shouldTrack = active && status && allowsTracking(status) && recipient?.location_consent;
    if (shouldTrack && !watch.current) {
      startTracking(id, (st) => {
        setTracking(st);
      }).then((sub) => {
        watch.current = sub;
        if (sub) activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      });
    } else if (!shouldTrack && watch.current) {
      stopWatch();
    }
  }, [active, status, recipient?.location_consent, id, stopWatch]);

  async function call(label: string, fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(label);
    setError(null);
    const { error } = await fn();
    setBusy(null);
    // Nunca se da por hecha una acción que el servidor no confirmó.
    if (error) setError(errorMessage('es', error));
    await load();
    return !error;
  }

  const respond = (accept: boolean) =>
    call(accept ? 'accept' : 'decline', () => supabase.rpc('respond_to_alert', { p_recipient: id, p_accept: accept }));

  if (error && !recipient) {
    return <Screen><Notice tone="danger">{error}</Notice><Button label="Reintentar" onPress={load} /></Screen>;
  }
  if (!recipient || !emergency || !status) return <Screen><Muted>Cargando…</Muted></Screen>;

  const target = base?.lat != null ? { lat: base.lat, lng: base.lng! } : emergency.lat != null ? { lat: emergency.lat, lng: emergency.lng } : null;
  const links = target ? navigationLinks(target, base?.name ?? emergency.title) : null;
  const eta = tracking.kind === 'tracking' && tracking.position && target ? estimateArrival(tracking.position, target) : null;
  const tone = RECIPIENT_TONE[status];

  return (
    <Screen>
      <View style={{ backgroundColor: active ? colors.red600 : colors.gray500, borderRadius: 14, padding: 18, gap: 6 }}>
        <Text style={{ color: colors.white, fontSize: 15, fontWeight: '700' }}>
          {active ? `EMERGENCIA · PRIORIDAD ${priorityLabel('es', emergency.priority).toUpperCase()}` : emergency.status === 'cancelled' ? 'CANCELADA' : 'CERRADA'}
        </Text>
        <Text style={{ color: colors.white, fontSize: 26, fontWeight: '900' }} accessibilityRole="header">{emergency.title}</Text>
        {emergency.address && <Text style={{ color: colors.white, fontSize: 17 }}>📍 {emergency.address}</Text>}
        {emergency.description && <Text style={{ color: colors.white, fontSize: 16 }}>{emergency.description}</Text>}
        {base && <Text style={{ color: colors.white, fontSize: 16 }}>Base: {base.name}</Text>}
      </View>

      {error && <Notice tone="danger">{error}</Notice>}
      <Row><Badge tone={tone.tone} text={recipientLabel('es', status)} />
        {counts && <Muted>Acuden {(counts.accepted ?? 0) + (counts.en_route ?? 0) + (counts.arrived ?? 0)} de {counts.total}</Muted>}</Row>

      {!active && (
        <Notice tone="neutral">{emergency.status === 'cancelled'
          ? `Activación cancelada${emergency.cancel_reason ? `: ${emergency.cancel_reason}` : ''}. No es necesario acudir.`
          : 'La activación está cerrada. El seguimiento se ha detenido.'}</Notice>
      )}

      {active && isAwaitingResponse(status) && (
        <View style={{ gap: 14 }}>
          <Button big variant="success" label={t('es', 'emergency.accept')} onPress={() => respond(true)} busy={busy === 'accept'} />
          <Button big variant="neutral" label={t('es', 'emergency.decline')} onPress={() => respond(false)} busy={busy === 'decline'} />
        </View>
      )}

      {active && allowsTracking(status) && (
        <>
          {!recipient.location_consent ? (
            <Card>
              <Text style={{ fontSize: 18, fontWeight: '800' }}>{t('es', 'location.consent_title')}</Text>
              <Muted>{t('es', 'location.consent_body')}</Muted>
              <Button variant="primary" label="Compartir mi ubicación" busy={busy === 'consent'}
                onPress={() => call('consent', () => supabase.rpc('set_location_consent', { p_recipient: id, p_granted: true }))} />
              <Muted>Puedes acudir sin compartirla: usa los botones de ruta.</Muted>
            </Card>
          ) : (
            <Card>
              <Text style={{ fontSize: 18, fontWeight: '800' }}>Compartiendo ubicación</Text>
              {tracking.kind === 'denied' && <Notice tone="danger">Permiso de ubicación denegado. Actívalo en Ajustes o usa la ruta externa.</Notice>}
              {tracking.kind === 'error' && <Notice tone="danger">No se pudo enviar la posición ({errorMessage('es', { message: tracking.message })}). Se reintentará.</Notice>}
              {tracking.kind === 'tracking' && (
                <Muted>{tracking.lastSentAt ? `Última posición enviada a las ${tracking.lastSentAt.toLocaleTimeString('es-ES')}` : 'Buscando señal GPS…'}
                  {tracking.accuracy != null ? ` · ±${Math.round(tracking.accuracy)} m` : ''}</Muted>
              )}
              {eta && <Text style={{ fontSize: 22, fontWeight: '800' }}>~{eta.minutes} min · {eta.km} km</Text>}
              <Notice>{t('es', 'location.background_warning')}</Notice>
              <Button variant="neutral" label="Dejar de compartir" busy={busy === 'stop'}
                onPress={() => call('stop', () => supabase.rpc('set_location_consent', { p_recipient: id, p_granted: false }))} />
            </Card>
          )}

          {links && (
            <Card>
              <Text style={{ fontSize: 18, fontWeight: '800' }}>Ruta a {base?.name ?? 'la emergencia'}</Text>
              <Row>
                {Platform.OS === 'ios' && <Button variant="primary" label="Apple Maps" onPress={() => Linking.openURL(links.apple)} />}
                <Button variant="primary" label="Google Maps" onPress={() => Linking.openURL(links.google)} />
                <Button variant="neutral" label="Waze" onPress={() => Linking.openURL(links.waze)} />
              </Row>
            </Card>
          )}

          <Button big variant="success" label="HE LLEGADO A LA BASE" busy={busy === 'arrived'}
            onPress={() => call('arrived', () => supabase.rpc('mark_arrived', { p_recipient: id }))} />
          <Button variant="ghost" label="Al final no puedo acudir" onPress={() => respond(false)} busy={busy === 'decline'} />
        </>
      )}

      {active && status === 'declined' && (
        <Card>
          <Muted>Has indicado que no puedes acudir. Si cambia tu situación:</Muted>
          <Button variant="success" label="Ahora sí puedo acudir" onPress={() => respond(true)} busy={busy === 'accept'} />
        </Card>
      )}
      {status === 'arrived' && <Notice tone="success">Registrada tu llegada a la base. Seguimiento detenido.</Notice>}

      <Muted>{t('es', 'app.disclaimer')}</Muted>
    </Screen>
  );
}
