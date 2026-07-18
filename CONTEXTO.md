# SellerBrain — Contexto del proyecto

> Documento para dar contexto a Claude Code (u otro asistente) al retomar el proyecto.
> Última actualización: julio 2026.

## Qué es

**SellerBrain** (sellersbrain.io) es un SaaS para vendedores de Amazon FBA. Su diferencial:
no muestra datos, **convierte cada dato en una acción con su valor en euros** ("negativiza
este término: +18€/mes", "reclama esta tarifa mal cobrada: +31€/mes"). Compite contra
Sellerboard (solo datos) y Helium 10 (solo keywords).

Lo construye **Venmon**, vendedor FBA en activo: 53 SKUs en ES/FR/IT/BE, dos marcas con
Brand Registry. Empresa: **VENMON Naturalmente SL**. Cada herramienta se valida contra su
propia cuenta real de Amazon.

## Arquitectura (YA EN PRODUCCIÓN, no rehacer)

```
Navegador (HTML/JS estático)
    │
    ├── Portal de herramientas (portal.html) — calculadoras, login por Google Sheets
    ├── Dashboard (dashboard.html) — panel + vista PPC, consume el Worker
    └── Landing (landing.html)
    │
    ▼  fetch con clave SB_API_KEY
Cloudflare Worker (worker.js)
    │  https://sellerbrain-api.info-venmon.workers.dev
    │  Cron diario 03:00 UTC
    │
    ├── Amazon Ads API (v3) — CONECTADA, datos reales entrando
    ├── Amazon SP-API — PENDIENTE (código escrito, faltan credenciales)
    │
    ▼
Supabase (PostgreSQL) — base de datos europea con RLS
```

### Servicios y cuentas
- **Cloudflare**: cuenta info.venmon@gmail.com · Worker `sellerbrain-api` · subdominio `info-venmon.workers.dev`
- **Supabase**: proyecto `sellersbrain` · URL `https://ttvixrppcjqggzaqtllp.supabase.co`
- **Web pública**: GoHighLevel (GHL) sirve sellersbrain.io · dominio en IONOS
- **Pagos**: Stripe · link Founders `https://buy.stripe.com/cNifZje6xfwF3nIfVm0sU0b`
- **Amazon Ads**: Security Profile "SellerBrain Ads" · Client ID `amzn1.application-oa2-client.6fee20076c2c4b50ad04b89c7743a920`
- **Repo**: GitHub (privado) conectado a Netlify para el entorno de PRUEBAS

### Secretos del Worker (en Cloudflare, no en el repo)
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ADS_CLIENT_ID`, `ADS_CLIENT_SECRET`,
`ADS_REFRESH_TOKEN`, `SB_API_KEY`. (SP-API pendiente: `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`,
`SPAPI_REFRESH_TOKEN`.)

## Perfiles de anunciante (Ads API), por país
- ES `3874077641287409` · FR `2792047721008132` · IT `1402821377609437` · BE `1737778900266529`
  (también existen SE, PL, NL, DE, UK en la cuenta)

## Base de datos (tablas principales)
- `pedidos_dia`, `settlements`, `settlement_lineas`, `devoluciones` (Plan 2 / SP-API)
- `ppc_dia` (PK fecha+pais) — total PPC por día y país
- `ppc_campanas` (PK fecha+pais+campania_id) — detalle por campaña
- `ppc_terminos` — términos de búsqueda 30 días
- `productos`, `busquedas_marca`, `cuentas_ads` (tokens OAuth de clientes), `ingestas` (acta del cron)
- Vistas: `v_fba_real`, `v_productos_mes`, `v_periodos`, `v_pnl_mes`, `v_stock_riesgo`, `v_serie_30d`
- **RLS activado en todas** — la clave pública no lee nada; el Worker usa la service key.

## Endpoints del Worker
- `GET /health` — público
- `GET /v1/dashboard` — payload del dashboard (contrato SB_DEMO)
- `GET /v1/ppc?days=30` — PPC diario por país
- `GET /v1/ppc/campanas?days=30` — detalle por campaña
- `GET /v1/ppc/terminos?pais=ES` — términos guardados
- `GET /v1/ads/profiles` — lista perfiles de anunciante
- `GET /v1/ads/terminos?pais=ES` — pide informe de términos 30 días (bajo demanda)
- `GET /v1/ads/terminos-fetch?pais=ES&id=REPORT_ID` — recoge informe ya generado
- `GET /v1/ads/fetch?pais=ES&id=REPORT_ID&fecha=YYYY-MM-DD` — recoge informe de campañas
- `GET /v1/ingest-test?pais=ES` — prueba de un país
- `POST /v1/ingest` — ingesta manual
- `GET /auth/ads/start?email=...` y `/auth/ads/callback` — OAuth de clientes (públicos)
- **Todos los `/v1/*` requieren `SB_API_KEY`** (cabecera `Authorization: Bearer` o `?key=`)

## Motores de tarifas (auditados contra Excel oficial 2026)
- **EU y USA 2026** en portal.html: incluye tramos pesados, Gran Tamaño (7 categorías),
  voluminoso, peso dimensional (EU ÷5000, USA ÷139). Verificados con tests.
- Nota: costes de producto = DDP total ex-VAT (China) o precio sin IVA (nacional, IVA recuperable).

## Estado por pieza
| Pieza | Estado |
|---|---|
| Portal de herramientas | EN PRODUCCIÓN (GHL) — versión fusionada con motores 2026 lista para subir |
| Backend Worker + Supabase | DESPLEGADO Y SEGURO |
| Amazon Ads API | CONECTADA · PPC real entrando (dato verificado: 14-jul ES 9,97€) |
| Amazon SP-API (Plan 2) | PENDIENTE de solicitar en Seller Central |
| Dashboard nuevo + vista PPC | CONSTRUIDO (ACoS/ROAS/TACoS) |
| Landing nueva | LISTA para publicar |
| Módulo EPR envases | CONSTRUIDO (deadline PPWR 12-ago-2026) |
| Entorno de pruebas Netlify | En montaje (repo GitHub) |

## Modelo de negocio
Detalle completo del ciclo de vida y reparto en `docs/precios-y-ciclo.md`.
- **Founders Beta:** 20€ pago único · 3 meses · 50 plazas máximo · sin renovación automática.
- **Continuación fundador (mes 4+):** 20€/mes o 200€/año, **precio bloqueado para siempre** por ser de los primeros.
- **Cohortes futuras:** el precio base sube según crece la base (25€/mes a ~200 usuarios, 29€/mes a ~300…); los fundadores NO se ven afectados (grandfathering).
- **Pago anual:** descuento proporcional (200€/año ≈ 16,67€/mes).
- Plan Completo (SP-API + Ads, todo automático): a definir dentro de esta estructura.

## PENDIENTES (en orden de prioridad)
1. **Seguridad**: clave de Google movida a `config.js` (hecho) · **login del navegador → Worker** (débil, es el punto flojo real)
2. Confirmar que el **cron nocturno** corre (mirar tabla `ingestas`)
3. **Motor de acciones** leyendo `ppc_terminos` → acciones "negativiza X" automáticas
4. Reglas de PPC de David (umbrales ACoS/ROAS/TACoS) → programarlas en el motor
5. **Bloque A / SP-API** en Seller Central → desbloquea Plan 2 (ventas, beneficio real, TACoS exacto)
6. **Gestión de tokens anuales** (política Amazon desde 30-jul-2026): guardar fecha de consentimiento, avisar y re-autorizar clientes antes de 365 días, manejar error `invalid_grant`
7. Subir a producción (GHL): landing nueva + portal fusionado
8. Anonimizar datos de la demo

## Convenciones
- **Marca (jul-2026): concepto ORBIT** — logo anillo verde esmeralda + punto (SVG inline),
  wordmark Seller**Brain** (Brain en verde), tagline "Data. Decisions. More Profit."
  Tema oscuro (#070B09) + verde esmeralda (#2EE6A0→#14B87A) como color primario.
  Aplicado en la landing; dashboard/portal pendientes de re-tematizar (aún naranja brasa).
- (Regla anterior: naranja brasa→ámbar, verde SOLO para dinero — sustituida por ORBIT.)
- Copy sin promesas infladas — reflejar solo lo que existe
- Documentación en Miro: https://miro.com/app/board/uXjVGu3XV4Y=/
- Contacto: hola@sellersbrain.io

## Archivos del repo (entorno de pruebas)
```
index.html         hub del entorno de pruebas
landing.html       portada nueva
dashboard.html     panel + vista PPC (apunta al Worker real)
portal.html        herramientas (clave leída de config.js)
epr.html           módulo EPR envases
ppc-horas.html     dayparting
config.example.js  plantilla de credenciales (SÍ se sube)
config.js          credenciales reales (NO se sube — .gitignore)
netlify.toml, _headers, robots.txt, .gitignore
```

## Nota sobre la clave de Google (histórico)
La clave de Google Sheets (`AIza...`) estuvo incrustada en portal.html y GitHub la detectó.
Acción tomada: movida a config.js (fuera del repo). **Pendiente**: restringirla por dominio
y API en Google Cloud Console, e idealmente sustituir el login client-side por validación en
el Worker (elimina el problema de raíz).
