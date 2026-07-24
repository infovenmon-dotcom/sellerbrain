-- =====================================================================
-- % de DEVOLUCIÓN por artículo + motivos. Ejecuta en Supabase -> SQL Editor.
-- Idempotente. Amplía v_satisfaccion_producto añadiendo, al final, dos columnas:
--   uds_vendidas   = unidades vendidas del SKU (últimos 90 días)
--   pct_devolucion = devoluciones ÷ uds vendidas (%), últimos 90 días
-- Todo (devoluciones, motivos y %) se calcula sobre los últimos 90 días para que
-- la tasa sea comparable. Los motivos ya venían clasificados (crítico = problema
-- del producto → posible reseña 1-2★; logística = transporte; neutro = otros).
-- =====================================================================

create or replace view v_satisfaccion_producto as
with d as (
  select
    sku,
    upper(coalesce(motivo, '')) as motivo,
    coalesce(cantidad, 1)       as cantidad
  from devoluciones
  where sku is not null and sku <> '' and sku not ilike 'amzn.gr.%'
    and (fecha is null or fecha >= (current_date - 90))   -- ventana 90 días
),
clas as (
  select
    sku, motivo, cantidad,
    case
      when motivo ~ 'DEFECT|QUALITY|NOT_AS_DESC|DESCRIPTION|PART|MISSING|SWITCHEROO|MATERIAL|WRONG_ITEM_SENT|DID_NOT_MATCH'
        then 'critico'
      when motivo ~ 'DAMAGE|CARRIER|PACKAG|WAREHOUSE|FULFILLMENT_CENTER'
        then 'logistica'
      else 'neutro'
    end as bucket
  from d
),
ventas as (
  select sku, sum(uds) as uds
  from v_ventas_dia
  where fecha >= (current_date - 90)
  group by sku
)
select
  c.sku,
  sum(c.cantidad)::int                                        as devoluciones,
  sum(c.cantidad) filter (where c.bucket = 'critico')::int    as criticas,
  sum(c.cantidad) filter (where c.bucket = 'logistica')::int  as logistica,
  sum(c.cantidad) filter (where c.bucket = 'neutro')::int     as neutras,
  round(100.0 * sum(c.cantidad) filter (where c.bucket = 'critico')
        / nullif(sum(c.cantidad), 0), 0)                      as pct_criticas,
  greatest(1.0, round(5 - 4.0 * sum(c.cantidad) filter (where c.bucket = 'critico')
        / nullif(sum(c.cantidad), 0), 1))                     as estrellas_est,
  mode() within group (order by c.motivo)                     as motivo_top,
  case
    when sum(c.cantidad) filter (where c.bucket = 'critico') >= 2
      or (sum(c.cantidad) filter (where c.bucket = 'critico') > 0
          and sum(c.cantidad) filter (where c.bucket = 'critico') * 2 >= sum(c.cantidad))
      then 'rojo'
    when sum(c.cantidad) filter (where c.bucket = 'critico') > 0
      then 'ambar'
    else 'verde'
  end                                                          as senal,
  coalesce(v.uds, 0)::int                                      as uds_vendidas,
  round(100.0 * sum(c.cantidad) / nullif(v.uds, 0), 1)         as pct_devolucion
from clas c
left join ventas v on v.sku = c.sku
group by c.sku, v.uds;

-- Comprobar:
-- select sku, devoluciones, uds_vendidas, pct_devolucion, motivo_top, senal
-- from v_satisfaccion_producto order by pct_devolucion desc nulls last;
