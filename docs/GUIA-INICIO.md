# 🚀 Guía de inicio de SellerBrain — para empezar desde cero

> Bienvenido. Esta guía asume que **es tu primer día** con SellerBrain y que no
> sabes aún qué hace ni cómo se usa. Léela una vez de arriba abajo: en 10 minutos
> sabrás manejarlo. No necesitas conocimientos técnicos.

---

## 1. ¿Qué es SellerBrain?

SellerBrain es tu **panel de control para vender en Amazon FBA**. Conecta tus datos
de Amazon (ventas, tarifas, publicidad, stock, devoluciones) y te los muestra
**ya masticados**, con una idea muy simple detrás:

> **Cada dato viene con la decisión al lado, y en euros.**
> No te dice solo "tu ACoS es alto"; te dice *"negativiza este término: recuperas
> 18 €/mes"*.

Está pensado para que un lunes por la mañana, en 5 minutos, sepas **qué hacer hoy**
para ganar más, sin tener que interpretar tablas ni cuadrar números a mano.

---

## 2. Lo primero: cargar tus datos (elige UNA vía)

Al entrar verás un **Dashboard de ejemplo (demo)** con datos ficticios, para que
veas cómo se ve todo lleno. Para ver **tus** datos, arriba a la derecha tienes dos
botones: **🔌 Conexión** y **📥 Cargar mis datos**. Tienes tres formas:

### Vía A — Automática (recomendada, cuando tu cuenta está conectada)
Si entraste con tu acceso de SellerBrain, normalmente **ya estás conectado**: el
sistema trae tus datos solo. Lo confirmas en **🔌 Conexión** → verás
*"✅ Conectado automáticamente con tu sesión"*. No hay que pegar ninguna clave.

### Vía B — Conectar tu cuenta de Amazon (OAuth)
En **🔌 Conexión** → botón **"Conectar mi cuenta de Amazon"**. Te lleva a Amazon,
das permiso, y a partir de ahí SellerBrain sincroniza tus ventas, tarifas y
publicidad **solo, una vez al día** (la publicidad, cada hora). Es la opción para
dejar de subir archivos.

### Vía C — Subir 3 archivos de Seller Central (sin conectar nada)
Si prefieres no conectar la cuenta, pulsa **📥 Cargar mis datos** y arrastra:
1. **🛒 Pedidos** — informe *All Orders* (.txt). *(También vale Transacciones de
   Pagos o el Informe de IVA mensual: el tipo se detecta solo.)*
2. **💶 Extracto (Settlement V2)** (.txt) — de aquí salen las **tarifas reales** por
   unidad. Sin esto, las tarifas se estiman.
3. **📣 PPC** (opcional) — Amazon Ads → Informes → Campañas por día (.csv/.xlsx).

Luego pulsa **🧠 Analizar mis datos**. 🔒 *Todo se procesa en tu navegador; ningún
dato sale de tu equipo.*

> **¿No pasa nada?** Si sigues viendo la demo, vuelve a **🔌 Conexión → 🔍 Probar
> conexión**. Y recuerda: los datos de Amazon se refrescan **una vez al día**; el
> indicador *"Datos: hace X"* (arriba a la derecha) te dice cuándo fue la última vez.

---

## 3. Configura tu perfil (una sola vez)

Antes de fiarte de los números de beneficio, dedica 3 minutos a esto. Está todo en
el menú lateral, en el grupo **"Fiscal y ajustes"**:

1. **🧮 Perfil fiscal** — dinos si eres **autónomo o sociedad**, tu **régimen**
   (general o recargo de equivalencia), país e IVA. Con esto, el beneficio se
   calcula **bien para tu caso** (y aparece la capa de recargo de equivalencia si te
   aplica). Es lo primero que deberías rellenar.
2. **Costes de tus productos** — el beneficio necesita saber cuánto te cuesta cada
   producto. Haz **clic en cualquier producto** de la tabla del Dashboard e
   introduce su **coste unitario SIN IVA ni recargo** (solo la base de tu factura de
   compra; la herramienta ya suma el IVA cuando toca). O usa **📥 Compras de
   mercancía** para calcularlo desde tus facturas.
3. **🔔 Alertas por email** (en ⚙️ Ajustes) — activa si quieres que te avisemos
   **fuera de la app** cuando se te acabe el stock, se dispare el ACoS, haya
   sobrecostes o un producto pierda dinero. Un correo al día, y solo si hay algo.

---

## 4. Qué tiene SellerBrain, sección por sección

El menú de la izquierda está agrupado. Aquí va qué es cada cosa y para qué sirve.

### 📊 Dashboard (la pantalla principal)
Tu foto del negocio: **beneficio neto** por periodo (hoy / ayer / mes / mes
pasado), el **P&L** (cuenta de resultados: de las ventas, resta IVA, coste,
tarifas, PPC…, hasta el beneficio real), la gráfica de ventas, la tabla de
**beneficio por producto**, y el bloque **🧠 Acciones de hoy** (lo que conviene
hacer, con su valor en €). *Consejo: pasa el ratón por cada línea del P&L: un ⓘ te
explica de dónde sale cada número.*

### 💶 Beneficio por producto
El detalle de rentabilidad producto a producto (margen, tarifas, PPC, devoluciones).
Al hacer clic en un producto ves su **detalle completo**: operaciones reales de
Amazon, tarifa por unidad, y su **dependencia de publicidad** (cuánto de sus ventas
viene de anuncios).

### 📣 PPC · En vivo
Tu publicidad. El **gráfico funciona como filtro maestro**: pincha un día, un mes o
selecciona un rango y **toda la pantalla** se ajusta (campañas, términos, países,
rentabilidad). Para cada **término de búsqueda** te da un **veredicto**:
- **Negativizar** (gasta y no vende → córtalo; con el botón **📋 copiar** te llevas
  el término listo para pegar en Amazon),
- **Techo de puja** (pocos datos aún, no lo mates todavía),
- **Bajar puja**, **Escalar** (funciona bien, invierte más) o **Vigilar**.

### 🕐 PPC · Horas
A qué horas del día gastas y vendes. En cada **franja mala te señala la campaña
culpable** (nombre + € que se está comiendo esa hora), para que ajustes horarios.

### 🎯 PPC · Calculadora
Simula pujas y ACoS objetivo según tu margen (break-even ACoS).

### 🔍 Detector de sobrecobros FBA
Detecta cuándo Amazon te cobra la **tarifa cross-border** (más cara) en vez de la
local, producto por producto y país por país. Te da hasta el **mensaje de
reclamación** listo para abrir el caso.

### 📐 Dimensiones y categoría
Calculadora de tarifa FBA por medidas: te muestra el **peso facturable** (el mayor
entre el real y el volumétrico) y avisa cuando Amazon cobra por volumen.

### 🩺 Salud del producto (según devoluciones)
Los motivos de devolución como señal de problemas de producto. *(Ojo: solo ve a
quien devuelve, no al insatisfecho que no devuelve.)*

### 📦 Stock y reposición
Cuánto stock te queda, **días de cobertura** según tu ritmo de venta, y cuándo
**pedir**. Puedes anotar stock **en tu almacén/casa** y la **fabricación por
producto** (lo que está por llegar) para planificar mejor.

### 🔑 Keywords · 🏷️ Títulos SEO · 🤖 Rufus · 🔎 Investigación de marca
Herramientas de contenido y mercado: keywords, generador de **títulos que cumplen
las reglas de Amazon**, auditoría de atributos para la IA de Amazon (Rufus), e
investigación de nichos/marca.

### 🧮 Calculadora EU / USA · ♻️ Cumplimiento UE (EPR + GPSR)
Calculadora de margen para expandir a otros mercados, y control de obligaciones de
cumplimiento (EPR/embalajes y GPSR) por país.

### 🧾 Ventanilla Única · IVA
Sube el **Informe de Transacciones de IVA** de Amazon y te saca el **IVA
intracomunitario (OSS)** por país de destino y, sobre todo, **qué modelos tienes
que presentar** (369, 303, 349…) y con qué importe.

### 📥 Compras de mercancía
Registra tus **facturas de proveedor**: calcula el **coste real por unidad** (que
alimenta tu beneficio) y tus obligaciones según origen (nacional / intracomunitario
/ importación), incluido el recargo de equivalencia si te aplica.

### ⚙️ Ajustes
Tu centro de configuración: **Perfil fiscal**, **Compras**, **Ventanilla Única**,
**Conexión y datos** y **🔔 Alertas por email** (activar/desactivar y umbrales).

---

## 5. Tu rutina de 5 minutos (lo que harás cada día)

1. Abre el **📊 Dashboard** y mira el **beneficio** y las **🧠 Acciones de hoy**.
2. Ejecuta las acciones que veas claras (negativizar un término con el botón copiar,
   subir una puja que escala, reclamar un sobrecoste…). Márcalas como hechas.
3. Revisa **📦 Stock**: si algo está en rojo, pídelo.
4. Si activaste las **🔔 alertas**, ya te habrá llegado el correo con lo urgente —
   no hace falta ni entrar para enterarte de lo importante.

---

## 6. ¿De dónde salen los números? (para que te fíes)

- **Beneficio = ventas SIN IVA − costes SIN IVA.** El IVA de tus ventas va a
  Hacienda, no es tuyo, por eso se resta. El IVA que pagas en tarifas de Amazon es
  recuperable, por eso no cuenta como coste (en régimen general).
- Las **tarifas FBA y comisiones** son las **reales** de tu extracto (settlement),
  por unidad — así cuadran aunque Amazon liquide con retraso.
- El **semáforo de productos** mide el margen **antes** de PPC; el **beneficio del
  P&L** ya **incluye** el PPC.
- Todo lo fiscal es **orientativo** y conviene validarlo con tu gestor.

> Regla de oro: si un número te choca, mira el ⓘ de esa línea y el indicador *"Datos:
> hace X"*. Casi siempre es cuestión de cuándo se sincronizó por última vez.

---

¿Dudas? Todo está diseñado para que **solo tengas que ejecutar**, no pensar. Empieza
por conectar tus datos (paso 2) y rellenar tu Perfil fiscal (paso 3); el resto se
va llenando solo.
