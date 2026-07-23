# Pasos en Amazon para conectar cuentas de clientes (hacer ESTA TARDE)

> Objetivo: que **otros vendedores** puedan autorizar su cuenta de Amazon en SellerBrain
> (SP-API por OAuth) + su publicidad (Ads, que ya tenemos). Lo que más tarda es la
> **revisión de Amazon del acceso a datos de comprador (PII)** — por eso conviene
> iniciarlo hoy. Todo esto se hace en **Seller Central → Partner Network → Develop Apps**.

---

## A) Registrar / ampliar la app SP-API para OAuth de terceros

1. **Seller Central** (cuenta de VENMON) → menú **Aplicaciones y servicios → Desarrollar aplicaciones**
   (Developer Central / Solution Provider Portal).
2. Si no existe, **crear una app** (o editar la actual). Datos:
   - **App name:** SellerBrain
   - **API type:** SP-API
   - **Roles** (marcar los que usamos):
     - Selling Partner Insights
     - Inventory and Order Tracking
     - Pricing
     - Amazon Fulfillment
     - **Finance and Accounting** (settlements/tarifas)
     - **Buyer Communication / Direct-to-Consumer Shipping → PII** (datos de comprador)
       → este es el **rol Restringido** que dispara la revisión extra.
3. **OAuth / Login with Amazon (LWA):**
   - En la sección **App registration**, configurar el **flujo de autorización web (OAuth)**.
   - **Redirect URI (OAuth Redirect URI):** pega exactamente
     `https://sellerbrain-api.info-venmon.workers.dev/auth/spapi/callback`
   - **Login URI (opcional):** la página desde la que el cliente pulsa "Conectar Amazon"
     (más adelante, la de onboarding). De momento puede ser la landing.
   - Anota el **Application ID (LWA client id ya lo tenemos)** → hay que ponerlo en Cloudflare
     como secreto **`SPAPI_APP_ID`**.
4. **Guardar como BORRADOR (Draft).** En borrador ya se puede autorizar en modo **beta**
   (con `version=beta`, que es justo lo que hace nuestro `/auth/spapi/start`). Para los
   **50 del beta** con borrador vale; para abrir al mundo hay que **publicar** la app.

## B) Solicitar la revisión de PII (lo que tarda)

1. Aceptar y cumplir la **Amazon Data Protection Policy (DPP)**.
2. Rellenar el **cuestionario de seguridad**: cómo guardamos y ciframos los tokens y los
   datos de comprador. Respuestas clave (ya es verdad en nuestro sistema):
   - Tokens de cliente **cifrados en reposo** (AES-GCM) en Supabase; clave en secreto de
     Cloudflare, nunca en el navegador. → *(implementado, `TOKEN_ENC_KEY`)*
   - **Cifrado en tránsito** (HTTPS/TLS en todo).
   - **Control de acceso**: login por miembro (JWT); la clave maestra nunca sale al cliente.
   - **Retención y borrado**: datos por cliente, borrables a petición (RGPD/DPP).
   - **Aislamiento** entre clientes (columna `seller` + filtrado en el backend).
3. Enviar a revisión. Amazon puede pedir evidencias adicionales → responder rápido.

## C) Ads API (publicidad) — ya vamos por OAuth

- Ya guardamos el refresh token por cuenta (`cuentas_ads`) vía `/auth/ads/callback`. ✔
- Confirmar en la consola de **Amazon Ads** que la app está **aprobada para producción**
  (no solo sandbox) y revisar límites por volumen.

---

## Qué necesito yo (en Cloudflare) para que funcione la conexión

Poner estos **secretos** en el Worker (Settings → Variables and secrets):

| Secreto | Qué es |
|---|---|
| `SPAPI_APP_ID` | El **Application ID** de la app SP-API (del paso A3). |
| `TOKEN_ENC_KEY` | Clave de cifrado de tokens: **32 bytes en base64**. Generar una y pegarla. |
| `SPAPI_APP_BETA` | `true` mientras la app esté en borrador (por defecto ya asume beta). Poner `false` al publicar. |

> Para generar `TOKEN_ENC_KEY` (32 bytes base64), en cualquier consola:
> `openssl rand -base64 32`  → pega el resultado como secreto.

Con eso, el enlace **"Conectar Amazon"** de un cliente será:
`https://sellerbrain-api.info-venmon.workers.dev/auth/spapi/start?email=SU_EMAIL`
→ el cliente autoriza en Amazon → su token queda **cifrado** en `cuentas_spapi`.

---

## Resumen de una frase para hoy

- **En Amazon:** registrar la app SP-API con **OAuth de terceros + roles PII**, dejarla en
  **borrador (beta)** para los 50 del beta, y **enviar la revisión de PII** (lo lento).
- **En Cloudflare:** añadir `SPAPI_APP_ID`, `TOKEN_ENC_KEY` y (opcional) `SPAPI_APP_BETA`.
- **Lo demás (aislar por cliente + ingesta multi-cuenta)** ya lo estamos dejando montado
  por dentro (ver `docs/escalar-100-clientes.md` y `sql/multicuenta.sql`).
