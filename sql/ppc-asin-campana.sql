-- =====================================================================
-- PPC por ASIN × CAMPAÑA (del informe Advertised Product de Amazon Ads)
-- Ejecuta en Supabase → SQL Editor. Seguro re-ejecutar.
--
-- Guarda el gasto/ventas de publicidad partido por CAMPAÑA y por SKU/ASIN,
-- por día. Con esto el panel PPC puede: elegir un ASIN y ver en qué campañas
-- ha gastado, cuánto en cada una, y (cruzando con ppc_presupuestos) si la
-- campaña está activa o parada. David esto lo trabaja por carteras; aquí sale
-- directo del ASIN.
-- =====================================================================

create table if not exists ppc_asin_campana (
  pais        text not null,
  campania    text not null default '',   -- nombre de la campaña (columna campaignName del informe)
  sku         text not null,
  asin        text default '',
  fecha       date not null,
  gasto       numeric default 0,
  clics       int     default 0,
  impresiones int     default 0,
  ventas_ppc  numeric default 0,
  pedidos_ppc int     default 0,
  actualizado timestamptz default now(),
  primary key (pais, campania, sku, fecha)
);

alter table ppc_asin_campana enable row level security;

-- Índice para las consultas por rango de fechas + país.
create index if not exists ppc_asin_campana_fecha_idx on ppc_asin_campana (fecha, pais);

-- Comprobar (tras una ingesta de PPC):
-- select asin, sku, sum(gasto) gasto, count(distinct campania) campanas
--   from ppc_asin_campana group by asin, sku order by gasto desc limit 20;
