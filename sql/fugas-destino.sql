-- =====================================================================
-- SOBRECOSTE POR PAÍS DE DESTINO (accionable: dónde te falta stock local).
-- Ejecuta en Supabase DESPUÉS de sql/envios-fc.sql y sql/fugas-tarifa.sql. Idempotente.
--
-- v_fuga_tarifa ya calcula el sobrecoste por (SKU + país de SALIDA) — desde dónde
-- se sirve. Pero lo ACCIONABLE es el país de DESTINO: a qué mercado le pierdes
-- dinero por servirlo desde fuera, para decidir dónde mandar inventario.
--
-- Esta vista NO recalcula el importe (para no desviarse del total ya validado):
-- solo cuenta, por (SKU + país de destino), cuántas unidades cross-border hay.
-- El worker reparte el sobrecoste ya calculado de cada SKU entre sus destinos en
-- proporción a esas unidades. Así el total global se mantiene idéntico.
-- =====================================================================

drop view if exists v_cross_destino_sku;
create view v_cross_destino_sku as
with rutas as (                              -- por pedido: país de salida y de destino
  select order_id as pedido,
         max(pais_salida)  as salida,
         max(pais_destino) as destino
  from envios_fc
  where coalesce(pais_salida,'')  not in ('', '?')
    and coalesce(pais_destino,'') not in ('', '?')
  group by order_id
)
select
  l.sku,
  r.destino                as destino,
  count(*)                 as uds_cross      -- líneas de tarifa (≈1 = 1 unidad) cross-border a ese destino
from settlement_lineas l
join rutas r on r.pedido = l.pedido
where l.importe < 0
  and coalesce(l.sku,'') <> ''
  and l.fecha >= (current_date - 90)
  and r.salida <> r.destino                  -- SOLO cross-border (salida ≠ destino)
  and ( l.concepto ilike '%fulfillment%' or l.concepto ilike '%fbaperunit%'
     or l.concepto ilike '%weight%handl%' )
group by l.sku, r.destino;

-- Comprobar:
-- select destino, sum(uds_cross) uds, count(distinct sku) skus
--   from v_cross_destino_sku group by destino order by uds desc;
