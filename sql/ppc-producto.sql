-- =====================================================================
-- v15 · PPC por PRODUCTO (informe Advertised Product de Amazon Ads)
-- Ejecuta en Supabase → SQL Editor (incógnito). Seguro re-ejecutar.
--
-- Guarda el gasto y las ventas de publicidad POR SKU (ventana de 30 días).
-- Con eso el dashboard calcula el ACoS REAL de cada producto y lo compara con
-- su break-even → semáforo verde (rentable) / rojo (en pérdida).
-- =====================================================================

create table if not exists ppc_producto (
  pais        text not null,
  sku         text not null,
  desde       text not null,     -- inicio de la ventana (YYYY-MM-DD)
  hasta       text not null,     -- fin de la ventana
  gasto       numeric default 0,
  clics       int     default 0,
  impresiones int     default 0,
  ventas_ppc  numeric default 0,
  pedidos_ppc int     default 0,
  actualizado timestamptz default now(),
  primary key (pais, sku, desde, hasta)
);
alter table ppc_producto enable row level security;

-- Comprobar (tras una ingesta de PPC):
-- select pais, sku, gasto, ventas_ppc,
--        round(100*gasto/nullif(ventas_ppc,0),1) as acos_real
-- from ppc_producto order by hasta desc, gasto desc;
