# SellerBrain — Documento maestro del proyecto

> Fuente única de la verdad: arquitectura, servicios, costes, cuentas, dominios,
> estado de Amazon, seguridad y tareas pendientes. Se actualiza según avanzamos.
> **Última actualización:** 2026-07-29 · **Worker:** v52-fundadores-ciclo

---

## 1. Qué es
**SellerBrain** (sellersbrain.io) — SaaS de analítica para vendedores de Amazon FBA.
Cada vendedor conecta su cuenta de Amazon y ve su **beneficio real por producto**,
control de **tarifas FBA**, **reembolsos pendientes**, **devoluciones**, **stock por
país**, **PPC** y **cumplimiento (EPR/GPSR)**. Sin datos personales de compradores (PII).

Empresa: **VENMON NATURALMENTE SL**.

---

## 2. Arquitectura
```
Navegador (dashboard.html, portal.html, ...)          →  hosting: NETLIFY
        │  JWT (login por email + código)
        ▼
Cloudflare Worker  (worker/worker.js)                 →  backend/API + cron horario
        │
        ├── Supabase (PostgreSQL, UE)                 →  base de datos (RLS)
        ├── Amazon SP-API (informes de vendedor)      →  pedidos, finanzas, FBA, BA
        ├── Amazon Ads API (PPC)                      →  campañas, términos, gasto
        ├── Stripe (webhook de pago)                  →  alta automática de miembros
        ├── Resend (email)                            →  email de acceso (pendiente)
        └── Anthropic / Claude (API)                  →  redacta el "plan de la semana"
```
- **Frontend:** HTML/JS estático en Netlify (deploy desde `main`).
- **Backend:** un único Cloudflare Worker. Se despliega **pegando `worker/worker.js`**
  en Cloudflare a mano. Verificar versión en `…workers.dev/version`.
- **Cron:** horario (`0 * * * *`). Cada hora: foto PPC + refresco de ventas; 03:00
  ingesta completa; 04:00 cierre PPC + presupuestos.

---

## 3. Servicios y costes (reales)
| Servicio | Para qué | Coste |
|---|---|---|
| **Claude (Claude Code)** | Construcción y mantenimiento del producto | **90 $/mes** |
| **Cloudflare Workers (Paid)** | Backend + cron | **~5 $/mes** (de pago por el límite de subpeticiones) |
| **Netlify (Pro)** | Hosting web | **20 $/mes** |
| **Supabase** | Base de datos | Gratis (plan free) |
| **Anthropic / Claude API** (dentro del producto) | Plan de la semana + análisis keywords | Pago por uso — **~0,04 US$ acumulado hasta ahora (despreciable)**; modelo configurable a uno más barato |
| **Stripe** | Cobros | Comisión por transacción |
| **Resend** | Email de acceso | Gratis (hasta 3.000/mes) — *pendiente de montar* |
| **IONOS** | Dominio sellersbrain.io | Anual (dominio) |

**Fijo mensual actual:** **~115 $/mes** = Claude Code (90) + Netlify (20) + Cloudflare (~5).
Más: uso de la API de Claude dentro del producto (bajo) + comisiones de Stripe + dominio IONOS (anual).

> Nota: hay **dos costes de Claude distintos** — (1) **Claude Code 90 $/mes** = herramienta con la
> que se construye/mantiene el proyecto; (2) **API de Claude** = la que usa el propio producto para
> redactar el "plan de la semana" (pago por uso, se puede abaratar cambiando de modelo).

---

## 4. Cuentas y roles
| Cuenta / email | Uso |
|---|---|
| **info.venmon@gmail.com** | Cuenta principal de trabajo / Google |
| **fernando.gil@me.com** | Desarrollador Amazon (Solution Provider Portal + Appstore) · Apple ID |
| **rubydelgado91@gmail.com** | Cuenta de vendedor de Amazon conectada (datos de VENMON) |
| Cloudflare | Login con **Google** (MFA en Google) |
| GitHub | Login con **Google** (repo del código) |
| Supabase | Cuenta propia (MFA activa) |

---

## 5. Dominios y DNS
- **sellersbrain.io** registrado en **IONOS**. El DNS se gestiona (de momento) en IONOS.
- Hoy la web "buena" está en **Netlify** (URL de Netlify); en sellersbrain.io hay una
  versión básica antigua.
- **Plan (sin prisa, cuando esté todo probado):** dejar el DNS en IONOS y añadir registros:
  - **Email (Resend):** registros SPF/DKIM en IONOS → habilita `acceso@sellersbrain.io`.
  - **Web:** apuntar sellersbrain.io a Netlify (registros que da Netlify), también en IONOS.
- No hace falta buzón de correo en IONOS: Resend solo firma con DNS.

---

## 6. Amazon Developer
- **App SP-API:** `Sellersbrain` · ID `amzn1.sp.solution.5406e62d-2666-4869-92b7-b6172bb261e4`
  - Perfil de desarrollador: **VENMON NATURALMENTE SL** (fernando.gil@me.com).
  - **Estado app:** Borrador. **Perfil PÚBLICO: en revisión por Amazon** (para habilitar
    OAuth de vendedores externos). Self-authorization: 9/10 libres.
  - Roles aprobados (sin PII): Listing de producto, Precios, Logística de Amazon, Finanzas
    y contabilidad, Seguimiento de pedidos e inventario, Análisis de marcas, AWD.
  - OAuth del worker: `…/auth/spapi/start` y `…/auth/spapi/callback`.
- **App Amazon Ads:** perfil de seguridad **"SellerBrain Ads"** (developer.amazon.com).
  Return URL `…/auth/ads/callback` **ya configurada**. OAuth multi-anunciante listo.

---

## 7. Seguridad
- **MFA activa** en las 5 cuentas clave: Amazon, Cloudflare (vía Google), Supabase,
  GitHub (vía Google), Apple ID.
- Documentos (en `docs/seguridad/`, también en PDF): Plan de Respuesta a Incidentes,
  Política de Contraseñas y Accesos, Mapa de respuestas del cuestionario de Amazon.
- Tokens de vendedor **cifrados (AES-GCM)** en la base de datos; secretos solo en Cloudflare.

### Secretos/variables configurados en Cloudflare (solo nombres, nunca valores)
`SB_API_KEY`, `SB_JWT_SECRET`, `TOKEN_ENC_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `SPAPI_REFRESH_TOKEN`, `SPAPI_APP_ID`,
`ADS_CLIENT_ID`, `ADS_CLIENT_SECRET`, `ADS_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`,
`STRIPE_WEBHOOK_SECRET` *(pendiente)*, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLYTO`,
`EMAIL_SOPORTE`, `EMAIL_LOGO`, `PORTAL_URL`, `SPAPI_APP_BETA`, `SPAPI_CONSENT_URL`, `CORS_ORIGIN`.

**Fundadores (ciclo de vida):** `STRIPE_LINK_MENSUAL` (20 €/mes), `STRIPE_LINK_ANUAL`
(200 €/año), `PREGUNTAS_SEGUIMIENTO` (opcional, separadas por `|`), `GRACIA_BORRADO_DIAS`
(por defecto 14), `BORRADO_AUTO` (`1` para activar el borrado real; **apagado** por defecto).

---

## 8. Modelo fundador y ciclo de vida (automático)
- **Acceso fundador: 25 € por 2 meses** (`inicio` = pago, `fin` = inicio + 60 días).
- Al terminar decide, **sin permanencia**: **20 €/mes** o **200 €/año** (2 meses de regalo).
- **Correos automáticos** (barrido diario del cron, 08:00 UTC, `procesarFundadores`):
  - **E−15 días:** seguimiento con preguntas (editables por `PREGUNTAS_SEGUIMIENTO`).
  - **E (mismo día):** renovación con enlaces de pago (mensual/anual).
  - **E+7 días:** último aviso + **baja** (se corta el acceso, `activo=false`).
- **Si renueva** (paga suscripción → webhook): `estado='renovado'`, se paran los correos, se amplía `fin`.
- **Si no renueva:** baja en E+7 y **borrado de datos** en E+7+`GRACIA_BORRADO_DIAS` (14) —
  **solo si `BORRADO_AUTO=1`**. Por defecto el borrado está **apagado** (se listan los pendientes).
- Admin: `GET /v1/fundadores` (estado), `POST /v1/fundador/fecha` (fijar fecha a mano),
  `GET /v1/fundadores/run` (lanzar el barrido para probar). SQL: `sql/fundadores.sql`.

## 8b. Flujo de alta de un cliente (onboarding)
```
Cliente paga (Stripe)
   → webhook /stripe/webhook crea el miembro (código SB-XXXX-XXXX) + seller = su email
   → (Resend) email de acceso al cliente        [pendiente de montar el email]
   → entra en portal.html con email + código    → JWT
   → dashboard → "Conectar mi cuenta de Amazon"  → OAuth  [se activa al aprobar la app pública]
```
- **Login:** por **email + código** (no contraseña). El código se liga al email en el primer uso.
- Hasta montar Resend, el email se envía **a mano** (el código queda creado en `miembros`).

---

## 9. Estado multicuenta (multiusuario)
| Fase | Estado |
|---|---|
| OAuth SP-API por vendedor (código) | ✅ listo · ⏳ Amazon revisa la app pública |
| OAuth Ads por vendedor (código) | ✅ listo (Return URL puesta) |
| Ingesta escritura por `seller` (fases 1-2) | ✅ hecho y validado (todo bajo `venmon`) |
| Identidad login→seller (columna + helper) | ✅ preparada, **sin activar** el filtro |
| Webhook de Stripe (alta automática) | ✅ código listo · ⏳ configurar en Stripe + secreto |
| Email automático (Resend) | ✅ funciona (dominio verificado, logo+marca, `hola@sellersbrain.io`) · ⏳ opcional: recepción/reenvío de `hola@` |
| Lectura aislada (fase 3) | ⏳ al tener un 2º vendedor real |
| Ads ingesta por vendedor | ⏳ pendiente |
| Repartir ingesta multicuenta en varios ticks | ⏳ cuando haya muchos vendedores (tope 1.000 subpeticiones) |

---

## 10. SQL a ejecutar en Supabase (por orden)
Ficheros en `sql/`. Los nuevos del multiusuario/onboarding:
1. `multicuenta.sql` — cuentas_spapi/ads + columna `seller` en tablas.
2. `multicuenta-pks.sql` — mete `seller` en la clave primaria (antes del 2º vendedor).
3. `miembros-seller.sql` — columna `seller` en miembros (mapa login→seller).
4. `stripe.sql` — tabla `stripe_eventos` (idempotencia del webhook).
5. Otros ya en uso: `reembolsos.sql`, `inventario-pais.sql`, `ppc-*.sql`, `fugas-tarifa.sql`, etc.

---

## 11. Despliegue
- **Frontend:** push a `main` → Netlify despliega solo.
- **Backend:** pegar `worker/worker.js` en Cloudflare a mano. Verificar `…/version`.
- **Cron Cloudflare:** `0 * * * *` (Workers → Triggers → Cron Triggers).
- **SQL:** ejecutar los ficheros en Supabase → SQL Editor (idempotentes).

### ⚠️ Netlify es por CRÉDITOS — no desplegar en cada commit
- Plan Pro = **3.000 créditos/mes** (reinician cada día ~11). **Cada despliegue en
  producción cuesta ~15 créditos.** Recarga automática **deshabilitada** (si se agotan,
  Netlify deja de desplegar; NO cobra de más).
- **Regla:** trabajar en la **rama de trabajo** (no despliega) y empujar a `main`
  **solo cuando haya que desplegar frontend, agrupando cambios**. Los commits de
  `worker/`, `sql/`, `docs/` NO deben desplegar (además hay `build.ignore` en netlify.toml).
- Ejemplo real a evitar: 153 despliegues en un día = 2.295 créditos (76% del mes).

---

## 12. Pendiente / próximos pasos
1. Amazon aprueba el perfil **público** → crear app pública → **Crear listado** → OAuth externos.
2. Configurar **Stripe** (webhook + `STRIPE_WEBHOOK_SECRET`) para el alta automática.
3. **Resend** (email automático) cuando el DNS de sellersbrain.io esté asentado.
4. **Fase 3:** activar la lectura aislada por `seller` (con un 2º vendedor real).
5. **Ads por vendedor** + repartir la ingesta multicuenta si crece el número de cuentas.
6. Migrar sellersbrain.io a la web buena (apuntar a Netlify) cuando esté todo probado.
