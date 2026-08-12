# Puesta en marcha + guion demo David (viernes)

> Objetivo: dejar TODO lo de esta semana funcionando y tener el guion listo.
> Los pasos A los das tú (Cloudflare + Supabase); yo no tengo acceso.

---

## PARTE A · Puesta en marcha (una sola vez)

Hazlo en este orden. Todo es **repetible sin riesgo** (si algo ya estaba, no pasa nada).

### 1) Desplegar el Worker v119
- Cloudflare → Workers & Pages → tu worker (`sellerbrain-api`) → **Edit code**.
- Copia TODO el contenido de `worker/worker.js` (rama `main` en GitHub) y pégalo.
- Pulsa **Deploy**.
- **Verifica:** abre `https://sellerbrain-api.info-venmon.workers.dev/v1/version`
  → debe responder **`v119-stock-ventadia-nombres`**. Si sigue en v118, no se ha desplegado.

### 2) Ejecutar el SQL en Supabase (SQL Editor → pega y Run, uno a uno)
En este orden:
1. `sql/margen-real.sql`  (P&L y tarifas por día — base)
2. `sql/pnl-periodo.sql`
3. `sql/serie-periodo.sql`
4. `sql/pnl-desglose.sql`  (desglose al pinchar cada línea del P&L)
5. `sql/ppc-keywords-dia.sql`
- Si alguno da error de "depende otra vista", vuelve a ejecutarlo — están hechos para eso.

### 3) Rellenar datos que faltan (en el panel, botón 🔌 Conexión / Admin)
- **Rellenar nombres** → trae nombres + ASIN + imágenes de Amazon. Va de 40 en 40:
  vuelve a pulsarlo hasta que no cambie el número.
- **Rellenar imágenes** → completa las fotos que falten (de los que ya tienen ASIN).
- **Rellenar PPC** (si aparece) → gasto diario real de anuncios.

### 4) Comprobación rápida (que TODO sale)
- **Stock:** un producto en riesgo muestra "🔴 ya tarde · llega DD/MM · −X d sin stock · ≈ −X€".
- **Nombres:** en Stock y en los informes ya NO salen códigos tipo `53-QO00-8SPC` (salvo los que Amazon no tenga en ningún sitio).
- **P&L:** el beneficio del filtro cuadra con las casillas de arriba.
- **PPC:** eliges una campaña arriba y toda la pantalla se filtra a esa campaña.
- **Generador:** botón "📦 Traer mi producto" → sale tu catálogo real.

---

## PARTE B · Guion de la demo con David

Historia: **"de datos reales a una decisión que mejora el beneficio"**. 4 paradas, ~8 min.

### 1. Beneficio real (Dashboard)
- Enseña las 6 casillas del mes y el **P&L que cuadra**.
- Frase: *"Todo son datos reales de Amazon. Si un dato no se ha podido recoger, lo decimos
  desde cuándo — nunca inventamos una cifra."*
- Pincha una línea del P&L → **se desglosa de dónde viene cada cargo**.

### 2. PPC · En vivo (el filtro maestro nuevo)
- Arriba, cambia **"Todas las campañas"** a una campaña concreta.
- Enseña cómo **toda la pantalla responde**: KPIs, gráfico, términos, keywords, plan de pujas,
  rentabilidad por campaña, placement.
- Frase: *"En un clic aíslo una campaña y veo su rentabilidad real y qué pujas bajar."*
- Señala que **SQP y Rentabilidad por producto** avisan de que no se filtran por campaña
  (son de otra dimensión) — *"no mezclamos datos que darían una cifra engañosa."*

### 3. Stock y reposición
- Muestra un producto en riesgo: **"ya tarde · llega el DD/MM · −X días sin stock · ≈ −X€"**.
- Frase: *"No solo avisa de que vas tarde: te dice cuándo llegaría si pides hoy, cuántos días
  estarías roto y cuánto dinero pierdes en ventas. Y cuenta tu stock de casa/almacén como si
  ya estuviera en Amazon."*

### 4. Listing con IA (la fusión + datos reales)
- Antes eran 4 apartados; ahora **2**: "Keywords y auditoría" y "Generador de listing".
- En el Generador, pulsa **"📦 Traer mi producto (catálogo real)"** → elige uno → se rellena solo.
- Genera con IA y enseña que **cada título se valida contra las reglas de Amazon** (75 car.,
  símbolos, promocional): *"no publicas un título que Amazon vaya a rechazar."*

### Cierre
- *"Esta semana: P&L que cuadra con desglose, PPC filtrable por campaña, stock que avisa en
  euros, y las herramientas de listing pasan de 4 a 2 y ya trabajan con tu catálogo real."*

---

## Pendiente para DESPUÉS del viernes (no crítico para la demo)
- **Generador desde ficha real completa** (traer también bullets/descripción actuales) → toca `worker.js`.
- **Encadenar** keywords analizadas → Generador (sin resubir CSV).
- **Seguridad**: bloqueo de login tras 10 intentos, cabeceras de seguridad, purga de retención → toca `worker.js`.
