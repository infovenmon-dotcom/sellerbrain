# Informes de Amazon — ruta exacta para cada módulo de SellerBrain

> Para que nadie se equivoque al subir los CSV. Amazon reorganiza los menús de vez en
> cuando y el texto cambia un poco según el país (ES/FR/IT/DE) y el idioma de la cuenta,
> así que se indica también el **nombre técnico** del informe (el que no cambia) y las
> **columnas clave** que usa el módulo. Todos se procesan en el navegador; nada sale del equipo.

---

## 1. Todos los pedidos (All Orders)  ·  `.txt`
**Lo usan:** EPR envases · Devoluciones (opcional) · Stock y reposición · Beneficio (unidades).

- **Ruta:** Seller Central → **Informes** → **Informes de Logística de Amazon**
  → categoría **Ventas** → **Todos los pedidos**.
- **Nombre técnico:** `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL`.
- **Cómo pedirlo:** "Solicitar descarga" (Request .txt), rango de fechas → cuanto más largo
  mejor (12–24 meses) para poder analizar campañas pasadas y velocidad de venta.
- **Formato:** archivo de texto separado por tabuladores (`.txt`).
- **Columnas clave:** `sku`, `quantity`, `purchase-date`, `sales-channel`, `item-status`.
- **Ojo:** NO es "Informe de pedidos" del panel de pedidos; es el de **Logística → Ventas**.

## 2. Transacciones de Pagos (Payments Transactions)  ·  `.csv`
**Lo usan:** Beneficio por producto (tarifas FBA REALES, comisión, IVA de "Otros ajustes").

- **Ruta:** Seller Central → **Pagos** (Payments) → **Transacciones** → filtra por
  **Rango de fechas** → **Descargar** (Download flat file, `.csv`).
- **Nombre técnico:** transacciones de pagos (Date Range Transaction report).
- **Formato:** `.csv`.
- **Columnas clave:** `total (eur)`, `tarifa de gestión logística`, `comisión por venta`,
  `tipo` (Pedido/Reembolso/Ajuste de inventario), `otros` (aquí viene el IVA).
- **Nota verificada:** este informe SÍ trae IVA (en "Otros ajustes", 21%) pero NO cuadra
  día a día con "Todos los pedidos" porque usa la fecha de **pago/envío**, no la de pedido.

## 3. Informe de transacciones de IVA (Amazon VAT Transactions)  ·  `.csv`
**Lo usan:** Beneficio (desglose de IVA mensual), cuando aplica.

- **Ruta:** Seller Central → **Informes** → **Documentos fiscales** / **Informes fiscales**
  → **Informe de transacciones de IVA de Amazon**.
- **Nombre técnico:** `Amazon VAT Transactions Report`.
- **Requisito:** tener activado el **Servicio de Cálculo de IVA** de Amazon (VCS).
- **Formato:** `.csv` mensual.
- **Columnas clave:** `total_activity_value_amt_vat_incl`, tipo de transacción, tipo impositivo.

## 4. Devoluciones de clientes (Customer Returns)  ·  `.txt` / `.csv`
**Lo usa:** módulo Devoluciones.

- **Ruta:** Seller Central → **Informes** → **Informes de Logística de Amazon**
  → categoría **Devoluciones de clientes** → **Devoluciones de clientes de Logística de Amazon**.
- **Nombre técnico:** `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA`.
- **Cómo pedirlo:** elige rango (últimos 3–12 meses).
- **Columnas clave:** `sku`, `quantity`, `reason`, `detailed-disposition`, `status`, `return-date`.

## 5. Inventario FBA (Manage FBA Inventory)  ·  `.txt` / `.csv`
**Lo usa:** módulo Stock y reposición (stock disponible por SKU).

- **Ruta:** Seller Central → **Informes** → **Informes de Logística de Amazon**
  → categoría **Inventario** → **Inventario de Logística de Amazon** (Gestionar inventario FBA).
- **Nombre técnico:** `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` (o "Manage FBA Inventory").
- **Columnas clave (cualquiera vale):** `afn-fulfillable-quantity`, `available`, `quantity`,
  `afn-total-quantity`.
- **Alternativa:** si no lo subes, escribe el stock a mano en la tabla del módulo (se guarda
  en tu navegador).

## 6. Campañas de PPC  ·  `.csv` / `.xlsx`
**Lo usan:** Beneficio (descontar publicidad) · PPC · Horas (dayparting).

- **Diario/por campaña:** Consola de **Amazon Advertising** → **Medición e informes** →
  **Informes** → crear informe de **Sponsored Products**, nivel campaña → descargar.
- **Por hora (dayparting):** Amazon **no** da la hora en los informes normales (son diarios).
  El dato horario real llega vía **Amazon Marketing Stream** (lo conectará SellerBrain en el
  backend — TAREA 11). El "ver ejemplo" del módulo de horas son datos **simulados**.
- **Automático:** el PPC diario ya entra solo por la **Ads API** (cron nocturno) → no hace
  falta subir nada para el panel de PPC en vivo.

---

## Resumen rápido (qué sube quién)
| Módulo | Informe(s) | Dónde |
|---|---|---|
| Beneficio por producto | Todos los pedidos + Transacciones de Pagos (+ IVA) | Logística→Ventas / Pagos→Transacciones |
| EPR envases | Todos los pedidos | Logística→Ventas |
| Devoluciones | Devoluciones de clientes (+ All Orders opcional) | Logística→Devoluciones |
| Stock y reposición | Todos los pedidos + Inventario FBA | Logística→Ventas / Logística→Inventario |
| PPC (vivo) | — (automático por Ads API) | — |
| PPC · Horas | Marketing Stream (backend) | — |

> Cuando la **SP-API** esté activa, casi todos estos dejan de subirse a mano: pedidos,
> settlements (tarifas reales), devoluciones e inventario entran solos por el cron.
