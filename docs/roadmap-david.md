# Roadmap tras la reunión con David

> Recopilación de todo lo que salió de la reunión (David muy motivado). Ordenado por
> bloques. Marcar ✅ según se hace. La parte de **Listing/Rufus/Reseñas** es la más
> importante y la de más trabajo → **se hace al final**, con detalle aparte.

---

## A. PPC (En vivo)
- **A1 · Segmentar el gráfico "Gasto vs ventas" por CAMPAÑA o TOTAL.**
  Ya tiene filtro por país. Añadir además filtro/selector por campaña (o "todas").
  Datos: `ppc_campanas` tiene fecha+país+campaña → se puede construir la serie diaria por campaña.
- **A2 · Dayparting (PPC · Horas): mismo filtro por campaña/total, si es posible.**
  Depende de tener datos por campaña **y hora**. Hoy el dayparting es simulado/CSV; los datos
  horarios reales exigen **Amazon Marketing Stream** (ver TAREAS 11). Sin esa fuente, el
  desglose por campaña-hora no es fiable. Nota: dejar claro qué se puede y qué no.
- **A3 · Unidades vendidas reales.** Hecho el paso 1 (columna "Uds" = pedidos atribuidos).
  Paso 2 pendiente: añadir `unitsSold14d` al informe Ads + columna `unidades_ppc` en
  `ppc_campanas` (solo rellena datos nuevos; histórico se queda con pedidos).

## B. Sobrecostes / Libro Mayor / stock por país
- **B1 · ⚠️ Stock en Alemania (DE) sin estar registrado de IVA allí → ALERTA de cumplimiento.**
  El Libro Mayor muestra stock SELLABLE en DE = **Amazon tiene su inventario físicamente en
  Alemania** (dato real, no bug). Suele pasar por **PAN-EU / colocación de inventario**.
  Almacenar mercancía en un país **crea obligación de registro de IVA** allí. → Convertirlo en
  un **aviso**: "Tienes stock en DE y no estás registrado de IVA allí: riesgo fiscal. Revisa
  PAN-EU/EFN o regístrate." Detectar países con stock fuera de los marketplaces del vendedor.
- **B2 · Tarifas de envío LOCAL distintas por país.**
  El detector de sobrecostes usa como "tarifa local" un proxy (percentil 15 de las tarifas del
  propio SKU), que en la práctica acaba siendo ~la de **España** para todo. Las tarifas FBA
  locales de FR/IT/DE… son **diferentes**. → El benchmark "local" debe ser **por país de
  destino**, no uno global. Revisar `v_fuga_tarifa` (sql/fugas-tarifa.sql) para comparar contra
  la tarifa local del país correspondiente. Mientras, avisar de que es una estimación.
- **B3 · Frecuencia del Libro Mayor.** Se actualiza **1×/día a las 03:00 UTC** (+ retraso propio
  de Amazon de ~1-2 días). → Mostrar "última actualización" en la pantalla para que no confunda.

## C. Autónomo en Recargo de Equivalencia (RE) — modo fiscal
- **C1 · Pestaña / modo "Recargo de Equivalencia".**
  El autónomo en RE **no repercute IVA en la venta** de Amazon (ya paga el recargo en la compra),
  pero **NO puede deducirse el IVA de los costes de Amazon** (comisiones, FBA, PPC…). → Al activar
  este modo, el cálculo de **coste y beneficio** cambia: el IVA de las tarifas de Amazon pasa a ser
  **coste real** (no recuperable), y la venta no lleva IVA de salida a liquidar. Un **toggle** en el
  panel que recalcula margen/beneficio bajo este régimen. (Contrastar el detalle exacto con David/gestor.)

## D. Stock y reposición (le gustó — mejoras)
- **D1 · Tiempo de FABRICACIÓN** seleccionable (si lo hay), igual que el tiempo de envío. Suma al
  lead time para el punto de pedido / fecha de rotura.
- **D2 · Stock propio en almacén/casa** por producto. Si tienes stock fuera de Amazon, que el sistema
  te **avise de enviar ESE stock primero a Amazon** antes de fabricar/comprar más.

## E. Listing / Rufus / Reseñas — lo más importante y lo de más trabajo (AL FINAL)
- Es lo que **menos convenció** y donde hay que currar. **Pendiente de explicación en detalle** con
  David. Rehacer/profundizar: generación y optimización de listing, auditoría Rufus (atributos IA),
  y explotación de **reseñas** (problema/diferenciación — se conecta con la herramienta de Nichos).
- **Se aborda cuando esté hecho todo lo anterior.** Tomar requisitos detallados antes de construir.

---

## Orden sugerido
1. **B1** (alerta stock DE / IVA) + **B3** (fecha de actualización) — rápido y de valor/riesgo.
2. **A1** (segmentar PPC por campaña) — visual, para enseñar.
3. **D1 + D2** (stock: fabricación + stock propio) — mejoras acotadas.
4. **C1** (modo Recargo de Equivalencia) — feature fiscal, contrastar detalle.
5. **B2** (tarifa local por país) — precisión del detector.
6. **A2** (dayparting por campaña) — depende de Marketing Stream.
7. **A3** (unidades reales) — cuando toque.
8. **E** (Listing/Rufus/Reseñas) — el grande, con requisitos de David, al final.
