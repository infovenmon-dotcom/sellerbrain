-- =====================================================================
-- DIAGNÓSTICO — Retiradas / eliminaciones de inventario de Amazon
-- Ejecuta en Supabase → SQL Editor. Sirve para "sacar el dato" y ver qué te
-- ha cobrado Amazon por retirar/eliminar stock (removal / disposal), por SKU.
-- Estos cargos son un COSTE REAL, pero NO son tarifa por venta.
-- =====================================================================

-- 1) Total de retiradas por producto (importe CON IVA, tal cual lo liquida Amazon)
select
  sku,
  round(-sum(importe), 2)            as retirada_con_iva,
  round(-sum(importe) / 1.21, 2)     as retirada_sin_iva,
  count(*)                           as lineas
from settlement_lineas
where concepto ilike '%removal%' or concepto ilike '%disposal%'
group by sku
order by retirada_con_iva desc;

-- 2) Detalle línea a línea (fecha, concepto y cuantía) de las retiradas
select fecha, sku, concepto, round(importe, 2) as importe
from settlement_lineas
where concepto ilike '%removal%' or concepto ilike '%disposal%'
order by fecha desc, sku;

-- 3) Para UN producto concreto: cambia 'PON_AQUI_EL_SKU' por su SKU y ve su
--    tarifa por unidad ya SIN la retirada + la retirada por separado.
-- select sku, uds_liq, fba, com, retiro,
--        round(fba / nullif(uds_liq,0), 2) as fba_por_ud,
--        round(com / nullif(uds_liq,0), 2) as com_por_ud
-- from v_fee_sku where sku = 'PON_AQUI_EL_SKU';
