# ✅ CHECKPOINT — agosto 2026 (punto estable "pre-recargo")

Punto de restauración congelado ANTES de empezar el Motor Fiscal de Recargo de
Equivalencia. Si algo se rompe o no convence, se vuelve aquí sin problema.

- **Rama de respaldo (en remoto):** `checkpoint-2026-08-pre-recargo` — commit `25bd86f`.
  (El proxy de git de este entorno no admite tags; se usa una rama, que hace la misma función.)
- **Worker desplegado:** `v75-backoff-largo` (SB_VERSION).
- **Cómo volver a este punto:**
  ```
  git fetch origin
  git checkout main
  git reset --hard origin/checkpoint-2026-08-pre-recargo   # deja main exactamente como este punto
  git push origin main --force-with-lease                  # (solo si quieres revertir main en remoto)
  ```
  Alternativa no destructiva: `git checkout checkpoint-2026-08-pre-recargo` para inspeccionar.
  Y volver a pegar el worker `v75` en Cloudflare si se hubiera cambiado.

---

## Qué funciona en este punto (frontend, desplegado)
- **PPC · En vivo:** el gráfico es filtro maestro por **día/mes/rango**; el chip de **país**
  filtra toda la pantalla (KPIs, Campañas, Términos, Por país, Rentabilidad). Columna
  "Ventas (uds)" = pedidos atribuidos (base del CVR).
- **PPC · Horas (dayparting):** en cada franja mala sale sola la **campaña culpable**
  (👉 nombre · €), sin filtrar. Selector de campañas de un toque.
- **Detector de sobrecostes FBA:** país de envío real (de `envios_fc` cuando esté cargado),
  **tarifa local REAL** = media de tus envíos locales (nada a mano), sobrecoste por país,
  mensaje de reclamación. Marca "real" vs "estim.". Centros sin identificar → "?" + botón
  "Preguntar a Amazon".
- **Stock por país (Libro Mayor):** carga bien (bug de la doble función resuelto), con fila
  **Σ Total**. Aviso de stock en país sin IVA.
- **Stock y reposición:** cabecera fija + buscador/filtro/orden; columna **"En almacén/casa"**
  (manual, guardada) y **fabricación por producto**; unidades **reservadas** ("+N res.") y
  fecha del snapshot para explicar el desfase con el Libro Mayor.
- **Ventanilla Única · IVA (nuevo):** subes el Informe de Transacciones de IVA (.csv) y saca
  OSS por país de destino, IVA a declarar (369), rutas salida→destino, régimen normal y
  movimientos de stock (FC_TRANSFER). Export CSV para el gestor. Todo en el navegador.
- **Calculadora de tarifa FBA por dimensiones:** muestra el **peso facturable** (mayor entre
  real y volumétrico) y avisa cuando Amazon cobra por volumen.
- Emails de acceso/ciclo fundador, feedback, nichos, etc. (previos).

## Backend (worker v75)
- Auto-ingest del **país de salida** (`GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL`) →
  `envios_fc`, en ventanas de 29 días (evita FATAL de >30d) y con backoff 30/60/90s ante 429.
- PPC términos/producto **por día** (v65+): informes DAILY, columna `fecha`.
- Sondas admin: `/v1/iva-check` (informe IVA, da 403 = falta rol fiscal),
  `/v1/envios-check` (envíos, OK), `/v1/envios-ingest?dias=&off=`.
- `/v1/stock` devuelve `reservado` + `snapshot`. `/v1/fugas` país honesto ('' si '?').
- Reintento con backoff ante 429 en `spapiCall`.

## Migraciones SQL de este checkpoint (ya deben estar corridas)
- `sql/ppc-diario.sql` — fecha en ppc_terminos/ppc_producto (sin pérdida).
- `sql/feedback.sql`, `sql/fundadores.sql` — previas.
- `sql/fix-reembolsos-seller.sql` — columna seller en reembolsos.
- `sql/envios-fc.sql` — tabla envios_fc (con RLS activado).
- `sql/fugas-tarifa.sql` — vista v_fuga_tarifa con tarifa local real (drop+create).

## Pendientes operativos (NO bloquean el checkpoint)
1. **Cargar `envios_fc`** cuando el cupo de Amazon (createReport) se reponga → botón
   "🚚 Cargar país de salida" o el cron nocturno. Hasta entonces el detector va en modo
   "estim." y se corrige solo.
2. **Identificar centros `MEA2` / `NXEA`** (país) → añadir a `FC_PAIS` en el worker.
3. Informe de IVA por API bloqueado (403, falta rol fiscal): de momento se sube el CSV a mano
   en Ventanilla Única. Auto-ingest listo para el día que Amazon apruebe el rol.
4. Config Stripe / Customer Portal / vars Cloudflare (previos).

## Siguiente fase (cuando se decida)
- **Motor Fiscal Recargo de Equivalencia** — spec en `docs/recargo-equivalencia.md`.
  Requiere confirmar detalle con el gestor antes de codificar supuestos.

---

# ✅ CHECKPOINT 2 — agosto 2026 (motor fiscal desplegado)

Segundo punto estable, **ya con el Motor Fiscal en producción** (Fases 0-3). Todo aditivo:
nada de lo del checkpoint 1 se rompió.

- **Rama de respaldo (en remoto):** `checkpoint-2026-08-motor-fiscal` — commit `90f5e07`.
- **Worker:** sigue `v75-backoff-largo` (no cambió el backend en esta fase).
- **Cómo volver a este punto:** igual que arriba pero con la rama
  `checkpoint-2026-08-motor-fiscal`.

## Qué se añadió (frontend, desplegado)
- **Perfil fiscal (Fase 0):** `fiscal.html` — forma jurídica, régimen (general / recargo de
  equivalencia; Sociedad fuerza general), país de establecimiento, países con IVA, OSS, tipo
  de IVA y escenario de facturación de Amazon. Se guarda en `sb_perfil_fiscal`. Al guardar,
  refresca el dashboard al instante.
- **Calculadora de margen (Fase 1a):** aplica el perfil. En RE suma IVA + recargo al coste y
  21% a tarifas/PPC. Coste **siempre base sin IVA ni recargo**.
- **P&L · tarjeta "Impacto fiscal" (Fase 1b):** en RE desglosa Beneficio general → + IVA
  nacional que te quedas − IVA de tarifas − IVA+recargo del producto → **Beneficio real (RE)**,
  con el delta vs general. En general/Sociedad: nota de que el P&L ya es real. Usa
  `PNL.iva_rep` real × fracción nacional.
- **P&L neto correcto:** `pnl_periodo` devuelve `iva_rep` (ventas − neto); el dashboard lo
  resta → el "Beneficio neto" es real (sin IVA de ventas). Eliminada la versión antigua que
  devolvía `iva=0` (beneficio inflado).
- **Ventanilla Única · panel "Modelos que te tocan" (Fase 3):** según perfil + informe subido
  lista 369 (importe real), 303 (general) / no-303 (RE), 349 + registro local si hay trasiego,
  y 309 (recordatorio RE). Importes con € del informe; el resto "revisar".
- **Menú lateral con scroll propio** (ya no se cortan las últimas pestañas) y **hub de Ajustes**
  real con accesos a Perfil fiscal, Ventanilla Única, Conexión y Cumplimiento UE, con estado.
- **Aviso "coste sin IVA ni recargo"** en los 4 puntos de entrada/cálculo del coste.

## Migraciones SQL de este checkpoint (correr en Supabase)
- `sql/margen-real.sql` — `v_pnl_mes` y `pnl_periodo` con `iva_rep` (P&L neto correcto).
- `sql/pnl-periodo.sql` — misma firma con `iva_rep` (ya no deja `iva=0`). Basta correr uno.

## Fases del motor fiscal
- Fase 0 (perfil) ✅ · Fase 1 (IVA deducible/no en calculadora y P&L) ✅ · Fase 3 (avisos de
  modelos) ✅ base.
- **Pendiente:** Fase 2 (recargo en compras de mercancía por tipo de IVA + origen — necesita
  subir facturas de compra) · Beneficio **por producto** con tratamiento RE por SKU en el
  dashboard (hoy el desglose RE está en el P&L global, no por SKU) · validación del gestor.

---

# ✅ CHECKPOINT 3 — agosto 2026 (Fase 2 + informe David + alertas por email)

Tercer punto estable. Todo aditivo: nada de los checkpoints 1 y 2 se rompió.

- **Rama de respaldo (en remoto):** `checkpoint-2026-08-alertas-david` — commit `3497ba8`.
- **Worker:** `v76-alertas-email` (SB_VERSION). **Requiere pegarlo en Cloudflare.**
- **Cómo volver a este punto:** igual que arriba con la rama `checkpoint-2026-08-alertas-david`.

## Qué se añadió (frontend, desplegado)
- **Motor fiscal · Fase 2 — Compras de mercancía** (`compras.html`, en Ajustes): registra
  facturas de proveedor → coste real por unidad (base sin IVA) + obligaciones por origen
  (309/349/DUA) en recargo de equivalencia. Export CSV. Guarda en `sb_compras`.
- **Beneficio real (RE) por producto** en el detalle del SKU (aditivo, mismo criterio que el
  P&L global).
- **Informe de David (quick wins):**
  - Bug **`+NaN€` arreglado** de raíz (formateador a prueba de NaN, global).
  - **Umbral de confianza en veredictos PPC**: solo 'Negativizar' con ≥15 clics y 0 ventas;
    5-14 → 'Techo de puja' (no infla el € recuperable); <5 → 'Datos insuf.'.
  - **Botón 📋 copiar término** en cada acción PPC.
  - **'Satisfacción del cliente' → 'Salud del producto (según devoluciones)'** con su límite.
  - **Tooltip de sincronización** para reducir dudas de 'esto no cuadra'.

## Alertas proactivas por email (backend, requiere desplegar worker v76)
- Motor diario (07:00 UTC) que manda resumen SOLO si hay algo: **stock bajo/rotura, ACoS
  alto (7d) y sobrecostes recuperables**. Email HTML con niveles crítico/aviso.
- **Multi-tenant**: cada vendedor recibe SUS alertas en SU email (seller = email). Stock se
  filtra por seller; ACoS/sobrecostes hoy solo para la cuenta propia (PPC/settlement aún
  single-tenant) → nunca se mezcla dato entre vendedores.
- **Opt-in por usuario** (Ajustes → 🔔 Alertas por email): on/off + umbrales (días stock,
  % ACoS, €/mes sobrecoste). Endpoints `GET/POST /v1/alertas-prefs` (JWT del miembro).
- Activación: `ALERTAS_EMAIL=1` (interruptor), `ALERTAS_TO` (solo la cuenta propia VENMON).
  Prueba: `GET /v1/alertas-test?to=correo[&seller=email_cliente]`.

## Migraciones SQL de este checkpoint (correr en Supabase)
- `sql/alertas-prefs.sql` — tabla `alertas_prefs` (opt-in + umbrales por vendedor, con RLS).

## Cierre del bloque "informe de David" (añadido tras el CP3)
- **Alerta de producto en pérdidas** (worker v77): beneficio − PPC < 0 en 30 días, con coste
  conocido y ventas ≥ `ALERTAS_PERDIDA_MIN`. Cuarto tipo de alerta por email.
- **Panel de "supuestos del cálculo"** en el P&L: ⓘ por línea (cómo se calcula) + nota de
  criterio. Aclara que el semáforo mide margen ANTES de PPC y el beneficio ya INCLUYE PPC.
- **Dependencia de publicidad por producto** (worker v78): en el detalle del SKU, barra
  ventas PPC / ventas totales (proxy del % orgánico vs pagado, #3/#11 de David).
- **Worker final del bloque: `v78-dependencia-ppc`.** Rama de respaldo movida a este punto.

### Del informe de David — hecho vs pendiente
- **Hecho:** bug `+NaN€` · veredictos PPC con umbral de confianza (techo de puja) · copiar
  término · "Salud del producto" · tooltip de sincronización · alertas por email (stock,
  ACoS, sobrecostes, pérdidas) con opt-in · supuestos del P&L · dependencia de PPC.
- **Pendiente (requieren datos/ingesta nuevos, son "proyectos"):** Buy Box / precio de
  competencia por ASIN + detector de hijacking · placement (ToS vs resto) · match type ·
  Sponsored Brands + Display · Search Query Performance · comparativa interanual ·
  ejecución directa vía Ads API (negativizar/pausar con confirmación) · ranking orgánico
  por keyword (limitación de Amazon; a nivel producto ya cubierto con la dependencia PPC).

## Pendientes generales (no bloquean)
- Fase 2 fiscal por SKU / avisos automáticos · ACoS y sobrecostes por cliente cuando Ads y
  settlement sean multi-tenant · validación del gestor (David).
