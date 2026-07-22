# Escalar SellerBrain a 100+ clientes — qué pedir a Amazon y qué necesitamos

> Preparado para la reunión con David. Dos frentes: (A) lo que hay que solicitar/tramitar
> **en Amazon** para conectar cuentas de otros sellers, y (B) lo que necesitamos **nosotros**
> (infraestructura) para soportar ≥100 clientes con sus datos aislados.

---

## A) LADO AMAZON — qué pedir para conectar cuentas de clientes

### 1. SP-API: pasar de "app privada" a "app autorizable por terceros"
Hoy usamos un **developer privado** con el refresh token de VENMON (una sola cuenta). Para que
**otros sellers** conecten su cuenta hay que:

- **Registrar/ampliar la aplicación en el Solution Provider Portal** (Seller Central → Apps &
  Services → Develop Apps) y activar el **flujo de autorización OAuth (LWA)**: el cliente pulsa
  "Autorizar", acepta, y Amazon nos devuelve **su** `refresh_token`. (Es el mismo patrón que ya
  usamos con la Ads API.)
- **Roles/permisos** a solicitar (los mismos que usamos): **Amazon Fulfillment, Inventory,
  Pricing, Selling Partner Insights, Finance/Reports**. Los datos de pedidos incluyen **PII**
  (datos de comprador) → Amazon exige el rol **"Restricted"** con revisión extra.
- **Revisión de Amazon (lo importante y lo que tarda):**
  - Aceptar y cumplir la **Data Protection Policy (DPP)** de Amazon.
  - Rellenar el **cuestionario de seguridad** (cómo ciframos y guardamos los tokens y la PII).
  - Para PII, Amazon puede pedir **evidencias de seguridad** (cifrado en reposo/tránsito,
    control de accesos, logs, retención y borrado de datos).
- **Publicación:** no hace falta salir en el "App Store" público; basta con la app **autorizable
  por OAuth** (los clientes autorizan con un enlace). Publicarla en el Marketplace Appstore es
  opcional (más adelante, para captación).

> **Qué pedir ya (esta semana):** iniciar el registro de la app SP-API para **OAuth de terceros**
> y solicitar los **roles Restricted (PII)**. Es lo que más tarda en aprobarse — cuanto antes se
> arranque, mejor.

### 2. Ads API (PPC): ya vamos por OAuth, ampliar aprobación
- Ya guardamos el `refresh_token` **por cuenta** (`cuentas_ads`) vía `/auth/ads/callback`. ✔
- Falta: confirmar que la **app de Ads está aprobada** para uso con clientes (no solo pruebas) y
  revisar los **límites de la Ads API** por volumen. Cada seller trae su propia cuota, pero la
  app tiene límites agregados.

### 3. Marketplaces
- Un **único set de credenciales de app** sirve para todos los marketplaces de una región
  (Europa: ES, FR, IT, DE, etc.). El cliente autoriza una vez y cubrimos sus marketplaces EU.
  Para USA/otras regiones haría falta el registro en esa región (más adelante).

---

## B) LADO NUESTRO — infraestructura para ≥100 clientes

### 1. Multi-tenant en la base de datos (lo primero)
- Añadir columna **`seller` (tenant_id)** a TODAS las tablas de datos (`pedidos_dia`,
  `settlement_lineas`, `devoluciones`, `ventas_sku_pais_dia`, `inventario`, `ppc_*`,
  `costes_producto`, `productos_catalogo`, `ingestas`…).
- **RLS en Supabase por `seller`** para aislamiento real (cada cliente solo ve lo suyo), y el
  Worker filtra por el `seller` del JWT en cada consulta.
- Los cimientos ya están: **login JWT por miembro** + patrón OAuth por cuenta. El salto es
  sobre todo **etiquetar datos por seller y filtrar** (ver `docs/multicuenta.md`).

### 2. Guardado seguro de credenciales por cliente
- Tabla `cuentas_spapi` / `cuentas_ads`: `seller`, `refresh_token` **cifrado**, marketplaces,
  estado. Los tokens NUNCA salen al navegador (solo viaja el JWT del cliente).
- Gestión de claves de cifrado (Cloudflare secrets / KMS). Política de **retención y borrado**
  (requisito de Amazon DPP y RGPD).

### 3. Ingesta que escala a 100 cuentas
- Hoy el cron hace 1 cuenta. Para 100: un **cron "dispatcher"** que encola una tarea por cuenta
  y las procesa en paralelo controlado. Recomendado: **Cloudflare Queues** (o D1/Durable Objects)
  para repartir la carga y reintentos.
- **Cloudflare Workers de pago ($5/mes)**: sube el límite de subpeticiones de 50 → **1000** por
  invocación. **Imprescindible** ya con 1 cliente (el PPC lo pide), y obligatorio a escala.
- **Buenas noticias de límites:** las cuotas de SP-API y Ads API son **por seller** (cada cuenta
  trae su propia cuota), así que 100 clientes = 100× cuota. No hay cuello de botella agregado
  salvo el nuestro (Workers/DB).

### 4. Capacidad de base de datos
- **Supabase Pro (~$25/mes)** para empezar (8 GB, backups, más conexiones). Estimación: unos
  cientos de MB por cliente/año → 100 clientes entran de sobra en Pro al principio; escalar de
  tier según crezca. Índices por `seller`+`fecha`.

### 5. Alta/onboarding self-service
- Registro → conectar Amazon (SP-API OAuth) y Ads (OAuth) con **su** enlace → aprovisionar.
- Pasar del `codigo` manual (bien para la beta con David) a **alta automática** cuando abramos.

### 6. Cobros (para monetizar como Vendorati: 25/49/79/199 €/mes)
- **Stripe** (suscripciones + prueba gratis). Ligar el plan al `seller` y limitar por volumen.

### 7. Seguridad y legal (obligatorio con datos de terceros)
- **RGPD:** política de privacidad, DPA con los clientes, cifrado, borrado a petición.
- **Cumplir la Amazon DPP** (lo mismo que exige la revisión SP-API).
- **CORS cerrado** al dominio propio, rate-limiting del login, monitorización de errores.

### 8. Observabilidad
- Logs y alertas por cuenta (ingesta OK/fallida), panel de estado interno.

---

## Coste aproximado a 100 clientes (mensual)
| Servicio | Coste |
|---|---|
| Cloudflare Workers Paid | ~5 € |
| Supabase Pro | ~25 € (escala con volumen) |
| Anthropic (IA: plan de la semana / keywords) | según uso (bajo, bajo demanda) |
| SP-API / Ads API | **gratis** |
| Stripe | % por cobro |
| **Total base** | **~30-60 €/mes** para 100 clientes (antes de IA/soporte) |

Márgenes muy sanos frente a 25-199 €/cliente.

---

## Plan por fases (recomendado)
1. **Ya (esta semana):** iniciar en Amazon el registro de la **app SP-API OAuth + roles PII** (lo
   que más tarda en aprobar). En paralelo, **Workers Paid** para desbloquear el PPC.
2. **Multi-tenant DB:** columna `seller` + RLS + filtrado en el Worker (los cimientos ya están).
3. **`/auth/spapi/callback` por seller** (replica del de Ads) + guardado cifrado de tokens.
4. **Ingesta multi-cuenta** con cola (Cloudflare Queues) + cron dispatcher.
5. **Onboarding self-service + Stripe.**
6. **IVA por producto + informe para el gestor** (lo hablado, valor para el cliente).

---

## Qué decir el viernes (resumen de una frase)
- **A Amazon ya podemos pedirle** (y conviene empezar ya, porque tarda): registrar la **app
  SP-API con OAuth de terceros y permisos de PII**, para que cada cliente autorice su cuenta.
- **Nosotros necesitamos**, para 100 clientes: multi-tenant con aislamiento (RLS), guardado
  cifrado de tokens por cliente, **Workers de pago + cola de ingesta**, Supabase Pro, onboarding
  self-service y Stripe. **Coste de infra estimado: ~30-60 €/mes para 100 clientes.**
- **Los cimientos ya están** (login por miembro, OAuth por cuenta con Ads, datos reales
  funcionando). El salto a escala es sobre todo **etiquetar/aislar por cliente + SP-API pública**.
