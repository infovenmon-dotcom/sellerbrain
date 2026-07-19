# Plan de Respuesta a Incidentes de Seguridad — VENMON NATURALMENTE SL / SellerBrain

> Versión 1.0 · Adoptado: 19-07-2026 · Próximas revisiones: enero y julio de cada año
> Responsable: Fernando Gil (titular) — fernando.gil@me.com

## 1. Alcance
Cubre toda la información obtenida de las API de Amazon (SP-API y Amazon Ads API)
procesada por la aplicación privada SellerBrain: Cloudflare Workers (computación),
Supabase/PostgreSQL en la UE (almacenamiento, con Row Level Security) y los
secretos/credenciales guardados cifrados en Cloudflare. No se maneja PII de
compradores de Amazon.

## 2. Roles y responsabilidades
- **Responsable de seguridad e incidentes:** Fernando Gil (titular de la cuenta).
  Único usuario con acceso a Cloudflare, Supabase, GitHub y Seller Central.
- No existen más empleados con acceso; si en el futuro los hubiera, se les
  asignará acceso por función y se actualizará este plan.

## 3. Detección
- Revisión de logs de Cloudflare (Worker) y de Supabase.
- Alertas de GitHub (secret scanning) sobre exposición de credenciales.
- Avisos de los proveedores (Cloudflare/Supabase/Amazon) y de usuarios.

## 4. Procedimiento ante un incidente
1. **Contención inmediata** (primeras horas):
   - Rotar credenciales afectadas: secretos del Worker en Cloudflare
     (SB_API_KEY, claves de Supabase, tokens LWA/refresh de Amazon).
   - Revocar autorizaciones comprometidas en Seller Central / Security Profile.
   - Si procede, desactivar temporalmente el Worker o poner el sitio en pausa.
2. **Notificación en ≤24 horas desde la detección:**
   - A Amazon: **security@amazon.com** con descripción, alcance, datos
     afectados y medidas tomadas (obligación de la Data Protection Policy).
   - A los usuarios afectados de SellerBrain, si sus datos se vieran implicados.
   - A la AEPD en ≤72 h si el incidente afectara a datos personales (RGPD).
3. **Erradicación y recuperación:** identificar la causa raíz, corregirla
   (parche/config), restaurar desde copias si procede y verificar integridad.
4. **Registro y lecciones aprendidas:** anotar el incidente en el registro
   (fecha, causa, alcance, acciones, tiempos) y aplicar mejoras.

## 5. Revisión del plan
Revisión formal **cada 6 meses** (enero y julio) o tras cualquier incidente,
actualizando roles, contactos y procedimientos.

## 6. Registro de incidentes
| Fecha | Descripción | Alcance | Acciones | Notificado a Amazon |
|---|---|---|---|---|
| — | — | — | — | — |
