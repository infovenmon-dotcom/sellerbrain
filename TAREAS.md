# TAREAS — SellerBrain (priorizadas)

> Para Claude Code. Cada tarea indica: qué, por qué, dónde, y qué NO hacer.
> Regla de oro: **no reconstruir lo que ya funciona.** El backend, la Ads API y los motores
> de tarifas están bien. Estas tareas son "terminar de blindar y pulir", no rehacer.

---

## TAREA 1 — Verificar que el repo quedó limpio de credenciales
**Por qué:** GitHub detectó una clave de Google en portal.html. Ya se movió a config.js,
pero hay que confirmar que el repo está limpio y config.js ignorado.

**Qué hacer:**
- Confirmar que `portal.html` NO contiene `AIzaSy***(clave de GHL, enmascarada)...` (debe leer de `window.SB_CFG`).
- Confirmar que `.gitignore` incluye `config.js`.
- Confirmar que `config.example.js` existe (plantilla) y `config.js` NO está trackeado por git
  (`git status` no debe listarlo; si lo lista, `git rm --cached config.js`).
- Verificar que el resto de archivos (dashboard, landing, epr) no tienen secretos incrustados.

**NO hacer:** no borrar el historial de git con force-push sin avisar al humano (puede romper
el repo si Netlify u otros dependen de él). La clave es de GoHighLevel y de solo lectura;
con el repo privado el riesgo está contenido.

---

## TAREA 2 — Login propio en el Worker (elimina la dependencia de GHL)
**Por qué:** el login actual valida en el navegador contra Google Sheets, con una clave que
resultó ser de GoHighLevel. Es débil (se salta con F12) y no es nuestro. Esta es la solución
de raíz y el paywall real que hace falta antes de vender.

**Qué hacer:**
- Crear tabla `miembros` en Supabase: `email` (PK), `activo` (bool), `plan`, `alta`, `expira`.
- Añadir endpoint en el Worker: `POST /v1/login` que recibe email+código, valida contra
  `miembros` (server-side), y devuelve un token de sesión firmado (JWT simple).
- El portal deja de leer Google Sheets: llama a `/v1/login`. La clave de GHL deja de usarse.
- Migrar la lista actual de miembros (del Google Sheet) a la tabla `miembros`.

**Dónde:** worker.js (nuevo endpoint) + portal.html (cambiar validarAcceso) + Supabase (tabla).

**NO hacer:** no exponer la lógica de validación en el cliente. El navegador solo manda
credenciales y recibe sí/no; nunca decide él.

---

## TAREA 3 — Confirmar y blindar el cron nocturno
**Por qué:** el cron de las 03:00 debe traer el PPC de los 4 países cada noche. Aún no se ha
confirmado que corra bien (los primeros datos entraron por prueba manual).

**Qué hacer:**
- Revisar en Supabase la tabla `ingestas`: debe haber una fila diaria ~03:00 origen 'cron'.
- Si no aparece, revisar en Cloudflare que el trigger `crons = ["0 3 * * *"]` está activo.
- Verificar que `ppc_dia` recibe filas con números DISTINTOS por país (no duplicados).
- El endpoint `/v1/ads/fetch` ya exige `fecha` obligatoria (se corrigió un bug de duplicados).

**Dónde:** Supabase (revisar datos) + Cloudflare (revisar trigger). Worker ya está preparado.

---

## TAREA 4 — Motor de acciones automático desde ppc_terminos ✅ (hecho 20-07-2026)
> **Hecho:** `generarAcciones()` (worker.js) ahora lee `ppc_terminos` (último snapshot)
> y genera 3 tipos de acción con reglas en `REGLAS_PPC` (editables): **Negativiza**
> (0 pedidos y ≥8 clics → € real desperdiciado), **Baja la puja** (ACoS ≥60%, muestra
> ACoS real) y **Escala** (ACoS ≤20% y ≥2 pedidos). Se fusionan con la acción de
> producto, se ordenan por impacto y se limitan a 10. Además el **cron** recoge los
> términos a `ppc_terminos` cada **lunes** (ES/FR/IT) para que salga sin subir nada.
> Los umbrales de `REGLAS_PPC` son el enganche para los de David (TAREA 5).
> Nota honesta: son **recomendaciones**, no ejecuta cambios en las campañas de Amazon.


**Por qué:** el diferencial de SellerBrain es "cada dato → una acción con €". Ya recogemos
términos de búsqueda por API (tabla `ppc_terminos`). Falta que el motor genere solo las
acciones "negativiza X" sin que el usuario suba nada.

**Qué hacer:**
- En `construirDashboard` del Worker (o en `generarAcciones`), leer `ppc_terminos` y aplicar
  las reglas: término con ≥8 clics y 0 pedidos en 30 días → acción "Negativiza X, +N€/mes".
- Añadir reglas de "escalar" (ACoS bajo + pedidos altos) y "bajar puja" (ACoS alto).
- Que el dashboard muestre esas acciones en el feed del Cerebro sin subir CSV.

**Dónde:** worker.js (generarAcciones) + dashboard ya tiene la vista lista.

---

## TAREA 5 — Reglas de PPC de David en el motor
**Por qué:** David (experto PPC, comunidad de 250) aportará sus umbrales de ACoS/ROAS/TACoS.
Codificarlos es convertir su método en software — el corazón del acuerdo con él.

**Qué hacer (cuando Venmon traiga los umbrales de David):**
- Parametrizar las reglas del motor: ACoS objetivo por tipo de campaña, umbral de ROAS para
  escalar, TACoS saludable. Que no estén "a fuego" en el código sino en una config editable.
- Idealmente, una tabla `reglas_ppc` en Supabase que David pueda ajustar.

**Dónde:** worker.js (motor de acciones) + posible tabla de configuración.

---

## TAREA 6 — Gestión de tokens anuales de Amazon (política nueva)
**Por qué:** desde 30-jul-2026, los tokens de clientes que conecten su cuenta caducan al año.
Hay que avisar y re-autorizar antes de los 365 días, y manejar el error `invalid_grant`.

**Qué hacer:**
- La tabla `cuentas_ads` ya guarda `creado` (fecha de consentimiento). Añadir cálculo de
  días restantes y un aviso cuando falten <30 días.
- En las llamadas a la Ads API, capturar el error `invalid_grant` y marcar la cuenta como
  "necesita reconexión" → mostrar botón "Reconectar Amazon" en el dashboard del cliente.
- El consentimiento de Venmon (hecho antes del 30-jul) NO caduca — esto es solo para clientes.

**Dónde:** worker.js (manejo de error + cálculo de caducidad) + dashboard (aviso de reconexión).

---

## TAREA 7 — Bloque A: SP-API en Seller Central (desbloquea Plan 2)
**Por qué:** conecta ventas y settlement automáticos → beneficio real y TACoS exacto sin CSVs.
Es la cola larga (aprobación de Amazon puede tardar).

**Qué hacer (lo inicia Venmon en Seller Central, no es código):**
- Seller Central → Aplicaciones y servicios → Desarrollar aplicaciones → perfil de desarrollador.
- Roles: Inventario, Precios, Logística, Finanzas, Brand Analytics. Sin PII.
- El código de ingesta SP-API ya está escrito en worker.js (planCompleto), esperando los
  secretos `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `SPAPI_REFRESH_TOKEN`.

**Dónde:** Seller Central (Venmon) → luego secretos en Cloudflare. Worker ya preparado.

---

## TAREA 8 — Publicar a producción (cuando todo esté validado)
**Por qué:** hasta ahora todo se prueba en Netlify. Cuando esté aprobado, subir a GHL.

**Qué hacer:**
- Subir a GHL: landing nueva + portal fusionado (con login del Worker ya integrado, tarea 2).
- Prueba de humo: Margen USA con producto >3lb y >$50 → tarifa base 7,23$ (señal de versión nueva).
- Anonimizar datos reales de la demo del portal.

**NO hacer:** no publicar hasta que el login del Worker (tarea 2) esté listo — no queremos
llevar a producción la dependencia de la clave de GHL.

---

## TAREA 9 — Detector de diferencias de inventario + reclamación automática a Amazon
**Por qué:** detecta inventario perdido/dañado por Amazon y abre casos automáticamente para
reclamarlo. Alta prioridad de negocio: "se vende solo" (recupera dinero real del vendedor).

**Depende de:** SP-API (TAREA 7). Sin SP-API no hay datos de inventario/ajustes, así que
NO se empieza hasta que la TAREA 7 esté aprobada y entrando datos.

**Qué hacer (cuando haya SP-API):**
- Cruzar inventario esperado vs. reportado por Amazon (informes de ajustes/reembolsos FBA:
  `GET_FBA_INVENTORY_ADJUSTMENTS_DATA`, `GET_FBA_REIMBURSEMENTS_DATA` y similares).
- Detectar unidades perdidas/dañadas no reembolsadas dentro de la ventana de reclamación.
- Generar el caso a Amazon (o el borrador del caso) con la evidencia y el importe a reclamar.
- Mostrarlo en el dashboard como acción con € ("reclama N unidades perdidas: +X€").

**Dónde:** worker.js (nueva ingesta + lógica de detección) + dashboard (feed de acciones).

---

## TAREA 12 — Capa de IA (Claude) sobre el motor de reglas ✅ (hecho 20-07-2026)
> **Hecho:** `generarPlanClaude()` en worker.js llama a la API de Claude (`claude-opus-4-8`,
> constante `MODELO_IA` editable) vía HTTP directo con `env.ANTHROPIC_API_KEY`. Endpoint
> `POST /v1/plan` (con SB_API_KEY): toma las acciones que ya calcularon las reglas + títulos
> de producto y devuelve un **plan de la semana redactado y priorizado**, que además **juzga la
> relevancia de cada término** (negativizar de verdad vs. bajar puja). Se genera **bajo demanda**
> (botón "Generar plan de la semana" en el Cerebro del dashboard), no en cada carga, para
> controlar el coste. Norma dura respetada: **la IA no inventa cifras** — los € y el ACoS salen
> de las reglas; Claude solo explica, prioriza y juzga.
> Arquitectura: **reglas = los números, Claude = el criterio y la redacción.**
> Pendiente: desplegar worker.js en Cloudflare (lo hace Venmon).

---

## TAREA 11 — Datos reales de PPC por hora (Amazon Marketing Stream)
**Por qué:** el módulo "PPC · Horas" (dayparting) ya analiza y propone franjas, pero hoy la
demo son datos **simulados** y el modo real exige un CSV con columna de hora que Amazon **no
genera** en sus informes normales (son diarios). La única fuente legítima de datos horarios es
**Amazon Marketing Stream** (feed push near-real-time).

**Qué hacer:**
- Suscribir la cuenta a **Amazon Marketing Stream** (datasets `sp-traffic` y `sp-conversion`,
  que traen la hora en `time_window_start`). Entrega por AWS SQS/Firehose → endpoint del Worker.
- Guardar los buckets horarios en Supabase (tabla `ppc_horas` o similar) y que el módulo
  "PPC · Horas" lea de ahí en vez de pedir CSV → sale solo, sin subir nada.
- Alternativa provisional (peor): sondear la Ads API cada hora y calcular deltas — solo hacia
  adelante y menos fiable. Preferir Marketing Stream.

**Dónde:** worker.js (nuevo consumidor de Stream + ingesta) + Supabase (tabla horaria) +
ppc-horas.html / dashboard (leer datos reales). El análisis del front ya está hecho.

---

## TAREA 10 — App móvil / de escritorio (más adelante)
**Por qué:** llevar SellerBrain a una app propia. Fase posterior, sin prisa.

**Qué hacer:** por definir. No se aborda hasta tener el núcleo web + SP-API estables.

---

## Nota sobre la TAREA 5 (reglas de PPC de David)
Bloqueada a la espera de que **David entregue sus umbrales concretos** de ACoS/ROAS/TACoS.
Hasta entonces no se puede parametrizar el motor con su método.

---

## Módulos del dashboard — hechos (jul-2026)
- **EPR envases (`epr.html`):** declaración por país con 6 materiales de embalaje
  (cartón, plástico, madera, metal, vidrio, otros). Sube el All Orders, pesa el
  envase una vez por SKU, calcula kg/país/material y **descarga la declaración en CSV**
  para presentarla al eco-organismo. Todo en el navegador.
- **Devoluciones (`devoluciones.html`):** sube el informe FBA "Devoluciones de clientes"
  (opcional: All Orders para la tasa %). Separa los motivos **controlables**
  (ficha/expectativa, calidad, tallaje) de los **no controlables** (cliente cambió de idea,
  logística, fraude), con recomendación por bloque. Muestra revendible vs pérdida,
  reembolsos de Amazon, tabla de SKUs a revisar y **descarga CSV**. Todo en el navegador.
  Ambos ya enlazados en la barra lateral del dashboard (`TOOL_SRC`).
- **Stock y reposición (`stock.html`):** con el All Orders (histórico) + inventario FBA (o stock
  a mano) calcula **días de cobertura**, **fecha de rotura**, **punto de pedido** (según lead time)
  y **cuánto reponer**. Incluye **análisis de periodo/campaña** (Black Friday, Prime Day, Navidad
  o rango a medida) con el **multiplicador vs. la media**. Cliente, y pasará a automático con SP-API.
- **Docs de apoyo:** `docs/informes-amazon.md` (ruta EXACTA de cada informe de Seller Central, por
  módulo, con nombre técnico y columnas) y `docs/multicuenta.md` (qué cimientos multicuenta ya están
  —JWT por miembro + OAuth Ads— y qué falta para conectar más sellers).

---

## Orden recomendado
1 (limpieza) → 3 (confirmar cron, rápido) → 2 (login Worker, la gorda) → 4 (motor acciones)
→ 5 (reglas David, cuando las traiga) → 6 (tokens) → 7 (SP-API, en paralelo, la inicia Venmon)
→ 9 (detector de inventario, DESPUÉS de la SP-API — alta prioridad de negocio) → 8 (publicar)
→ 10 (app, más adelante).
