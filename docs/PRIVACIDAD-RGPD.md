# Privacidad y RGPD

Lo que el sistema hace por diseño y lo que **debe revisar la organización con asesoría jurídica** antes de usarlo en operaciones reales. Esto no es asesoramiento legal.

## Datos que se tratan

| Dato | Para qué | Quién lo ve | Conservación por defecto |
| --- | --- | --- | --- |
| Nombre, apellidos, correo | Identificación y acceso | Uno mismo; responsables y admins. Otros voluntarios: "Nombre I." | Mientras sea miembro |
| Teléfono (opcional) | Contacto alternativo en emergencias | Uno mismo; responsables y admins | Mientras sea miembro |
| Rol, estado, código interno | Permisos | Uno mismo; responsables y admins | Mientras sea miembro |
| Cualificaciones y caducidad | Elegibilidad para servicios | Uno mismo; responsables y admins | Mientras sea miembro |
| Disponibilidad e inscripciones | Organizar guardias | Miembros de la organización | Con las guardias |
| Respuestas a alertas e historial | Coordinación y trazabilidad | El propio voluntario (las suyas); responsables y admins | 5 años (`emergency_retention_days`) |
| **Ubicación GPS** | Saber quién llega y cuándo | El propio voluntario; responsables y admins | **Solo la última posición, mientras acude.** Se borra al llegar, rechazar, retirar el permiso o cerrar. Máximo 12 h (`location_retention_minutes`) |
| Tokens de dispositivo | Enviar avisos | Uno mismo | Hasta revocar; 180 días sin uso |
| Registro de envíos | Detectar fallos de entrega | Responsables y admins | 180 días |
| Auditoría administrativa | Seguridad y rendición de cuentas | Admins | 2 años, sin datos personales ni coordenadas |

## Medidas implementadas

- Minimización: no se guarda recorrido GPS; los voluntarios no ven contactos de otros; la auditoría no copia datos personales.
- Consentimiento de ubicación **por activación**, revocable en cualquier momento desde la app.
- Aislamiento entre organizaciones en base de datos (RLS + claves compuestas), probado.
- Retención automática configurable (`private.run_retention()`, cada 15 min con pg_cron).
- Sin secretos en clientes; sin datos sensibles en logs.
- Cifrado en tránsito (HTTPS) y en reposo (Supabase).

## Pendiente de revisión jurídica y organizativa

1. **Responsable del tratamiento** y, si procede, **Delegado de Protección de Datos**.
2. **Base jurídica** de cada tratamiento. La ubicación se plantea con consentimiento por activación; valorar si en voluntariado encaja mejor el interés legítimo o el cumplimiento de la relación de voluntariado (Ley 45/2015 del Voluntariado), y documentarlo.
3. **Evaluación de impacto (EIPD)**: la geolocalización de personas y el tratamiento de datos de salud indirectos (p. ej. motivos de exclusión como "baja médica") apuntan a que es recomendable o necesaria. Valorar prohibir motivos de salud en el campo de exclusión.
4. **Encargados del tratamiento** y contratos (art. 28): Supabase (alojar en región UE, p. ej. Frankfurt), Expo (servicio push, EE. UU.), Apple y Google (APNs/FCM), proveedor de mapas y de alojamiento web. Revisar transferencias internacionales (Marco de Privacidad de Datos UE-EE. UU. o cláusulas contractuales tipo).
5. **Información a los voluntarios** (arts. 13-14): texto de privacidad en la app y en el alta.
6. **Plazos de conservación** definitivos (los de la tabla son propuestas).
7. **Procedimiento de derechos** (acceso, rectificación, supresión, oposición, portabilidad). El sistema permite exportar los datos de una persona por SQL. La supresión con historial de emergencias se hace **anonimizando** el perfil con `anonymize_member()` (implementada y probada; falta la pantalla de admin). La cuenta de acceso se borra después desde Supabase Auth.
8. **Registro de actividades de tratamiento**.
9. **Brechas de seguridad**: procedimiento de notificación a la AEPD en 72 h.
10. **Menores**: si hay voluntarios menores de edad, condiciones adicionales.
