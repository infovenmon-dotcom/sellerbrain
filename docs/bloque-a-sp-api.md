# Bloque A — Solicitar acceso SP-API en Seller Central (TAREA 7)

> Lo inicia el humano en Seller Central. Es "la cola larga": la aprobación de
> Amazon puede tardar de días a semanas — por eso conviene lanzarlo YA.
> El código de ingesta ya está escrito en `worker/worker.js` (planCompleto):
> en cuanto existan los 3 secretos, el cron nocturno empieza a traer pedidos,
> settlements (tarifas reales) y devoluciones solo.

## Qué desbloquea
- Ventas y unidades diarias por SKU (sin subir CSVs)
- Tarifas FBA REALES cobradas (settlements) → beneficio real y sobrecobros
- Devoluciones FBA automáticas
- Brand Analytics (términos de búsqueda reales de Amazon)
- El Plan 2 "Completo" del negocio y, después, el detector de inventario (TAREA 9)

---

## FASE 1 — Perfil de desarrollador (la que hay que lanzar ya)

1. Entra en **Seller Central** con el usuario TITULAR de la cuenta.
2. Menú ☰ → **Aplicaciones y servicios** → **Desarrollar aplicaciones**
   (Develop Apps). Si es la primera vez, te pedirá crear el
   **Perfil de desarrollador** → "Registrarse como desarrollador".
3. Rellena el formulario así:
   - **Tipo de desarrollador:** desarrollador PRIVADO (la app es solo para tu
     propia cuenta de vendedor; no vendes software a terceros… todavía).
   - **Caso de uso / descripción** (puedes pegar esto):
     > "Aplicación privada para mi propia cuenta de vendedor. Automatiza la
     > descarga de mis informes de pedidos, settlements/finanzas y logística
     > FBA hacia mi propio panel de análisis interno. Sin acceso a datos
     > personales de clientes (PII)."
   - **Roles a solicitar** (marca SOLO estos — sin PII se aprueba antes):
     - ✅ Inventario y seguimiento de pedidos (Inventory & Order Tracking)
     - ✅ Logística de Amazon (Amazon Fulfillment)
     - ✅ Finanzas y contabilidad (Finance & Accounting)
     - ✅ Precios (Pricing)
     - ✅ Brand Analytics
   - **PII / datos personales (nombre, dirección del comprador…):** **NO**.
     Responde que no los necesitas. (Todo lo del plan funciona sin PII, y
     pedir PII multiplica el escrutinio y el tiempo de aprobación.)
   - **Preguntas de seguridad de datos** (dónde almacenas, cifrado, quién
     accede): responde con la realidad del stack —
     > "Los datos se procesan en Cloudflare Workers y se almacenan en
     > Supabase (PostgreSQL, UE) con Row Level Security activado. Los
     > secretos/credenciales se guardan cifrados en Cloudflare (variables
     > secret). Acceso restringido al titular."
4. Envía. Amazon puede escribir por email pidiendo aclaraciones —
   **responde rápido**, cada ida y vuelta son días.

> Nota: ya NO hace falta cuenta de AWS ni IAM ARN para SP-API (Amazon lo
> retiró). Si algún formulario antiguo lo menciona, se puede dejar en blanco
> o indicar que se usa el flujo actual solo con LWA.

## FASE 2 — Crear la app y autorizarla (cuando aprueben la Fase 1)

1. **Desarrollar aplicaciones** → **Añadir nueva app cliente**:
   - Nombre: `SellerBrain`
   - Tipo de API: **SP-API**
   - Roles: los mismos 5 de arriba.
2. En la fila de la app → **Ver** credenciales **LWA**:
   - Copia `Client ID` (empieza por `amzn1.application-oa2-client…`)
   - Copia `Client Secret`
3. En la misma fila → **Autorizar** → **autorizarte a ti mismo**
   (self-authorize) → te muestra el **Refresh Token** (`Atzr|…`).
   **Cópialo en ese momento** (luego se puede regenerar si se pierde).

## FASE 3 — Poner los secretos y encender (5 minutos)

1. Cloudflare → Workers & Pages → **sellerbrain-api** → Settings →
   **Variables and Secrets** → añade como **Secret**:
   - `LWA_CLIENT_ID`     = el Client ID
   - `LWA_CLIENT_SECRET` = el Client Secret
   - `SPAPI_REFRESH_TOKEN` = el Refresh Token
2. No hay que tocar código: `worker.js` detecta los secretos y pasa solo de
   plan "analisis(ads-only)" a **"completo"**.
3. Probar sin esperar al cron: lanzar `POST /v1/ingest` (con la SB_API_KEY)
   o esperar a las 03:00 UTC.
4. Verificar en Supabase:
   ```sql
   select ejecutada, plan, resumen from ingestas order by ejecutada desc limit 3;
   -- plan debe decir 'completo'
   select count(*) from pedidos_dia;      -- empieza a llenarse
   select count(*) from settlement_lineas; -- tarifas reales
   ```

## ¿Y para TODOS los vendedores? (futuro Plan Completo para clientes)
El acceso privado de esta guía solo conecta la cuenta propia. Para que cualquier
vendedor autorice SellerBrain (como ya hacen con la Ads API) hay que **ampliar
el perfil de desarrollador a público**:
- Es el mismo perfil, la misma app y los mismos roles — se amplía y Amazon
  re-revisa con un cuestionario de seguridad más exigente (semanas).
- Nada de lo hecho en privado se pierde; el Worker ya tiene el patrón OAuth
  (flujo de Ads) que se replica para SP-API.
- Ventaja: al ir SIN PII, la revisión pública es mucho más llevadera.
**Estrategia: privado ahora (datos propios ya) → público cuando el Plan
Completo para clientes esté listo para venderse.**

> NOTA (jul-2026): Amazon ha movido el registro al **Solution Provider Portal**
> (solutionproviderportal.amazon.com). El flujo real fue: registrarse → elegir
> la cuenta de vendedor existente → "Crear aplicaciones que usen las API del
> colaborador comercial" → verificar identidad (KYC: registro de empresa + DNI)
> → configurar perfil/roles/seguridad (respuestas de esta guía) → crear la app.

## Estado
- [x] Registro en Solution Provider Portal completado (19-07-2026)
- [x] Identidad verificada (reutilizó el KYC existente de la cuenta)
- [x] MFA activado en Supabase y Cloudflare (20-07-2026)
- [x] Perfil enviado: 5 roles sin PII, "desarrollador privado" — **EN REVISIÓN por Amazon** (20-07-2026)
- [x] **APROBADO por Amazon (20-07-2026, el mismo día)** — acceso global con los 5 roles
- [~] App de producción creada y autorizada (Client ID/Secret + Refresh Token) — Venmon indica que ya está hecho (20-07-2026)
- [~] Secretos en Cloudflare (`LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `SPAPI_REFRESH_TOKEN`) — Venmon indica subidos; **pendiente de confirmar** con la 1ª ingesta
- [ ] **Primera ingesta 'completo' verificada** — la tabla `ingestas` estaba vacía (0 filas): la ingesta completa solo corre por el cron 03:00 UTC o por `POST /v1/ingest`. Se deja al **cron de la noche del 20→21-07-2026**.
  - Verificación (mañana): `select ejecutada, plan, resumen from ingestas order by ejecutada desc limit 3;`
    - `plan='completo'` → secretos SP-API OK; `resumen` trae los pasos (pedidos/settlements/devoluciones/brand_analytics) con sus errores si los hubiera.
    - `plan='analisis(ads-only)'` → los `LWA_*`/`SPAPI_*` no se detectan (revisar nombre exacto/valor/Worker).
