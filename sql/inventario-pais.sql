-- =====================================================================
-- STOCK POR PAÍS (dónde está almacenado cada SKU). Ejecuta en Supabase.
-- Idempotente. Lo alimenta el Worker con el informe paneuropeo de inventario
-- por país (GET_AFN_INVENTORY_DATA_BY_COUNTRY). Sirve para:
--   · saber si una venta se pudo servir en local (había stock en ese país),
--   · quitar el "?" del detector de sobrecostes,
--   · mostrar el stock por país en la pestaña de Stock.
-- =====================================================================

create table if not exists inventario_pais (
  sku         text not null,
  pais        text not null,      -- ES / FR / IT / DE / BE ...
  unidades    integer default 0,
  actualizado timestamptz default now(),
  primary key (sku, pais)
);
alter table inventario_pais enable row level security;

-- Vista de apoyo: total por SKU + lista de países donde tiene stock.
create or replace view v_inventario_pais as
select
  sku,
  sum(unidades)                                   as total,
  string_agg(pais || ':' || unidades, ', ' order by unidades desc) as por_pais
from inventario_pais
where unidades > 0
group by sku;

-- Comprobar:
-- select * from inventario_pais order by sku, unidades desc;
-- select * from v_inventario_pais order by total desc;
