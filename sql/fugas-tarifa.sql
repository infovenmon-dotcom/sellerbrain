-- =====================================================================
-- DETECTOR DE FUGAS DE TARIFA (cross-border) — tarifa local REAL por SKU y país.
-- Ejecuta en Supabase -> SQL Editor DESPUÉS de sql/envios-fc.sql. Idempotente.
--
-- Idea: la "tarifa local" NO se estima; es lo que Amazon te cobra de VERDAD cuando
-- sirve en LOCAL (envío salida=destino). Con envios_fc sabemos qué líneas del
-- settlement fueron locales y cuáles cross-border (salida<>destino). La local real =
-- media de las tarifas de los envíos locales de ese SKU en ese país. El sobrecoste =
-- lo pagado de más en las unidades cross-border frente a esa local real.
--
-- Si aún no hay envios_fc (o un SKU no tiene envíos locales conocidos), se cae a una
-- ESTIMACIÓN (percentil 15) y la fila se marca local_real=false para no confundir.
--
-- Tarifas del settlement CON IVA -> /1,21 (IVA recuperable). ~1 línea = 1 unidad.
-- =====================================================================

-- La borramos y recreamos (evita el error de CREATE OR REPLACE al cambiar columnas;
-- nada en la BD depende de esta vista, solo la lee el worker).
drop view if exists v_fuga_tarifa;
create view v_fuga_tarifa as
with rutas as (                              -- por pedido: país de salida y de destino (envios_fc)
  select order_id as pedido, max(pais_salida) as salida, max(pais_destino) as destino
  from envios_fc
  where coalesce(pais_salida,'') not in ('', '?')
  group by order_id
),
lineas as (
  select
    l.sku,
    coalesce(r.salida, nullif(l.pais,''), '?') as pais,                 -- país de SALIDA real (o el de la línea)
    (r.salida is not null) as ruta_ok,                                  -- sabemos la ruta de este pedido
    (r.salida is not null and r.destino is not null and r.salida <> r.destino) as es_cross,  -- cross-border
    abs(l.importe) / 1.21 as fee
  from settlement_lineas l
  left join rutas r on r.pedido = l.pedido
  where l.importe < 0
    and coalesce(l.sku,'') <> ''
    and l.fecha >= (current_date - 90)
    and ( l.concepto ilike '%fulfillment%' or l.concepto ilike '%fbaperunit%'
       or l.concepto ilike '%weight%handl%' )
),
bench as (
  select
    sku, pais,
    count(*)                                                              as uds,
    round(avg(fee), 2)                                                    as fee_medio,
    round(max(fee), 2)                                                    as fee_max,
    round(avg(fee) filter (where ruta_ok and not es_cross), 2)            as fee_local_real,  -- media REAL de envíos locales
    count(*)      filter (where ruta_ok and not es_cross)                 as uds_local,
    round((percentile_cont(0.15) within group (order by fee))::numeric,2) as fee_local_est    -- estimación (fallback)
  from lineas
  where pais <> '?'
  group by sku, pais
),
det as (
  select l.sku, l.pais,
    count(*) filter (where l.ruta_ok and l.es_cross)                                  as uds_cross,
    sum(l.fee) filter (where l.ruta_ok and l.es_cross)                                as fee_cross_sum,
    count(*) filter (where l.fee > coalesce(b.fee_local_real, b.fee_local_est)*1.10)  as uds_caras_est
  from lineas l
  join bench b on b.sku = l.sku and b.pais = l.pais
  group by l.sku, l.pais
),
calc as (
  select
    b.sku, b.pais, b.uds, b.fee_medio, b.fee_max,
    coalesce(b.fee_local_real, b.fee_local_est)     as fee_local,
    (b.fee_local_real is not null)                  as local_real,
    case when b.fee_local_real is not null then d.uds_cross else d.uds_caras_est end  as uds_caras,
    case when b.fee_local_real is not null
         then (d.fee_cross_sum - b.fee_local_real * d.uds_cross)                      -- pagado de más en cross vs local real
         else (b.fee_medio - b.fee_local_est) * b.uds end                            as sobrecoste_90d
  from bench b
  join det d on d.sku = b.sku and d.pais = b.pais
)
-- OJO: CREATE OR REPLACE VIEW exige mantener el ORDEN y nombre de las columnas
-- existentes; las nuevas (local_real) van AL FINAL.
select
  sku, pais, uds, fee_medio, fee_local, fee_max, uds_caras,
  round(100.0 * uds_caras / nullif(uds, 0), 0)  as pct_caras,
  round(sobrecoste_90d, 2)                       as sobrecoste_90d,
  round(sobrecoste_90d / 3.0, 2)                 as sobrecoste_mes,
  local_real
from calc
where uds >= 10
  and sobrecoste_90d >= 5
order by sobrecoste_mes desc;

-- Comprobar:
-- select sku, pais, local_real, fee_medio, fee_local, uds_caras, sobrecoste_mes
--   from v_fuga_tarifa order by sobrecoste_mes desc;
-- ¿Cuántas filas ya con tarifa local REAL (necesita envios_fc cargado)?
-- select local_real, count(*) from v_fuga_tarifa group by 1;
