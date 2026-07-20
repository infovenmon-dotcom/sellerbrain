# Multicuenta — preparar SellerBrain para conectar más sellers

> Objetivo: que el sistema pase de "una sola cuenta (Venmon)" a "cada seller ve SUS datos"
> sin rehacer nada. Aquí queda anotado qué **ya está puesto** (los cimientos) y qué **falta**,
> por si hay que preparar algo más potente. Estrategia: single-tenant ahora → activar
> multicuenta cuando el Plan Completo esté listo para vender.

---

## ✅ Cimientos que YA están puestos
1. **Login propio por miembro con JWT.** `/v1/login` valida `email`+`código` contra la tabla
   `miembros` y devuelve un **token firmado (HS256)** que lleva el `email` del seller. El Worker
   ya sabe **verificarlo** (`verificarJWT`) y el dashboard lo usa para leer datos — sin exponer
   la clave maestra al navegador. **Este token es la "identidad" de cada seller.**
2. **`codigo` como clave primaria** en `miembros`, con `email` ligado en el primer uso. Cada
   seller (o clave gratis de David/su mujer) es una fila independiente → el modelo de usuarios
   ya es multi-usuario.
3. **Patrón OAuth por cliente ya funcionando (Ads API).** `/auth/ads/callback` guarda el
   `refresh_token` de **cada cuenta** en `cuentas_ads`. Es exactamente el patrón que se replica
   para la SP-API: el seller autoriza y guardamos su token; nada "a fuego".
4. **Endpoints de lectura aceptan el token del miembro** (`/v1/dashboard`, `/v1/ppc`, `/v1/plan`),
   los de admin siguen con la clave maestra. La puerta de seguridad ya distingue ambos.

## ⛳ Lo que falta para multicuenta "de verdad"
1. **`tenant` (email o codigo del seller) en TODAS las tablas de datos**
   (`pedidos_dia`, `settlement_lineas`, `devoluciones`, `ppc_dia`, `ppc_terminos`, `ingestas`, `busquedas_marca`, `cuentas_ads`, `cuentas_spapi`). Hoy no lo llevan porque solo hay una cuenta.
   → Añadir columna `seller` (o `tenant_id`) y rellenarla en cada ingesta.
2. **Aislamiento por seller** — dos opciones (elegir una):
   - **RLS en Supabase** por `seller` (lo más seguro), o
   - **Filtrar en el Worker** usando el `email` del JWT en cada `selectSupabase(... where seller=eq.EMAIL)`.
   `construirDashboard` y `generarAcciones` deben recibir el seller del token y filtrar por él.
3. **SP-API pública + OAuth por seller.** Ampliar el perfil de desarrollador de **privado a
   público** (mismo perfil, mismos roles, re-revisión de Amazon) y replicar el flujo de Ads:
   `/auth/spapi/callback` → guardar `refresh_token` de cada seller en `cuentas_spapi`.
   (Hoy la SP-API usa los secretos únicos de Venmon en Cloudflare — eso es lo single-tenant.)
4. **Cron por cuenta.** `ingestaDiaria` debe **recorrer todas las cuentas conectadas** (ES/FR/IT
   por seller), no solo la de Venmon, y etiquetar cada fila con su `seller`.
5. **Alta/onboarding del seller:** al registrarse, conectar Ads y (futuro) SP-API con su propio
   OAuth; el `miembros.codigo` se liga a sus `cuentas_ads`/`cuentas_spapi`.

## 🧭 Orden recomendado para escalar (cuando toque)
1. Añadir `seller` a las tablas + backfill de los datos actuales como "venmon".
2. Filtrar lectura por el `email` del JWT (Worker) — cambio pequeño, ya tenemos el token.
3. Ampliar perfil SP-API a público + `/auth/spapi/callback` por seller.
4. Cron multi-cuenta.
5. Cerrar CORS al dominio de Netlify y revisar límites/tarifas de las APIs por volumen.

## Nota de seguridad ligada a esto
- La `SB_API_KEY` maestra **no** debe viajar al navegador de un seller (ya no lo hace: usan su
  JWT). Mantener así.
- Los secretos de cada seller (refresh tokens) van cifrados en Supabase/Cloudflare, nunca en el
  cliente. El navegador solo manda su JWT y recibe SUS datos.

> Resumen: los **cimientos de identidad y OAuth ya están** (JWT por miembro + patrón Ads). El
> salto a multicuenta es sobre todo **etiquetar los datos por seller y filtrarlos**, más
> **SP-API pública**. Nada de lo hecho se tira.
