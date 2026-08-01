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
