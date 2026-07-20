# App móvil de SellerBrain — preparación con las integraciones actuales

> Objetivo: dejar claro que **el backend ya sirve como API para una app móvil** y qué falta.
> La app no reinventa nada: consume el mismo Worker (misma API, mismo login) que el dashboard.

---

## ✅ Lo que YA tenemos (la app se apoya en esto)
- **API REST propia (el Worker):** `sellerbrain-api.info-venmon.workers.dev` con endpoints ya
  usables desde una app: `/v1/login`, `/v1/dashboard`, `/v1/ppc`, `/v1/plan`, `/v1/keywords`.
- **Login con JWT:** `/v1/login` (email+código) devuelve un **token firmado**. La app lo guarda
  en almacenamiento seguro (Keychain iOS / Keystore Android) y lo manda como `Authorization:
  Bearer` — exactamente igual que el navegador. Ya está soportado en el Worker (`verificarJWT`).
- **Integraciones vivas por detrás:** Ads API (PPC), Claude (plan IA + listing de keywords),
  Supabase (datos) y, en cuanto se encienda, SP-API (ventas/stock/devoluciones). La app las usa
  **a través del Worker**, nunca directo → los secretos nunca salen del backend.

## 📱 Qué haría la app (lo que más brilla en móvil)
- **Avisos push accionables:** "📦 PIDE YA stock de X (rotura en 5 días)", "🚫 Negativiza «término»
  → +N€/mes", "📉 ACoS alto en Z". El motor de reglas + IA ya genera estas acciones.
- **Plan de la semana (IA)** de un vistazo (endpoint `/v1/plan`).
- **Consulta rápida:** márgenes, cobertura de stock, PPC del día, devoluciones.
- **Generar listing / analizar keywords** desde el móvil (`/v1/keywords`).
- **Subir informes** desde el móvil (o, con SP-API, sin subir nada).

## 🧭 Dos caminos (recomendación: empezar por PWA)
1. **PWA (rápido, reutiliza el dashboard actual)** — el dashboard ya es responsive. Añadir
   `manifest.json` + service worker → **instalable** en la pantalla de inicio, funciona offline
   básico y admite **notificaciones web push**. Sin tiendas, sin código nativo. Es el 80% del valor
   con el 20% del trabajo. **Ideal para la beta.**
2. **App nativa (React Native / Expo)** — una sola base para iOS+Android, push nativo (FCM/APNs),
   mejor UX y publicable en App Store / Play Store. Consume la MISMA API. Es el paso cuando la
   PWA se quede corta o queramos estar en las tiendas.

## ⛳ Lo que falta para la app
1. **Notificaciones push:** web push (para la PWA) o FCM/APNs (nativa). Guardar el token de push
   del dispositivo por miembro y disparar avisos desde el cron/motor de acciones.
2. **Pulir la API para móvil:** versionar (`/v1/…` ya está), paginación donde haga falta, y
   respuestas ligeras. Cerrar CORS al dominio propio.
3. **Multicuenta** (ver `docs/multicuenta.md`): para que cada seller vea SUS datos en su app.
4. **Onboarding móvil:** login por código + (futuro) conectar Amazon con OAuth desde el móvil.

## Estrategia
**PWA sobre el dashboard actual para la beta** (rápido, reutiliza todo) → **React Native** cuando
haya que estar en las tiendas y con push nativo. El backend (Worker + JWT + integraciones) **ya es
el de la app**; no hay que rehacerlo.
