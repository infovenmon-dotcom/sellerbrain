-- =====================================================================
-- DESGLOSE del P&L — al pinchar en una línea (FBA, Comisión, Almacenaje,
-- Devoluciones, Otros) muestra DE DÓNDE salen esos cargos: el detalle por
-- CONCEPTO del settlement de Amazon. Así se ve, p.ej., cuánto de "FBA" es la
-- tarifa por unidad y cuánto es flete de entrada (inbound) o retiradas.
-- Misma clasificación que v_settle_clasificado, pero conservando el concepto.
-- Ejecuta en Supabase. Idempotente.
-- =====================================================================

create or replace view v_settle_desglose as
select
  fecha, sku, concepto, importe,
  case
    when concepto ilike '%reserve%' or tipo ilike '%transfer%'
         or concepto ilike '%balance%'                                      then 'ignorar'
    when concepto ilike 'ItemPrice/%'                                       then 'ignorar'
    when concepto ilike '%Reimbursement%'                                   then 'ignorar'
    when concepto ilike '%Cost of Advertising%' or concepto ilike '%advertising%' then 'ppc'
    when tipo ilike '%refund%' and importe < 0                              then 'dev'
    when tipo ilike '%refund%'                                              then 'ignorar'
    when concepto ilike '%storage%'                                         then 'alm'
    when concepto ilike '%commission%' or concepto ilike '%referral%'       then 'com'
    when concepto ilike '%fulfillment%' or concepto ilike '%fbaperunit%'
         or concepto ilike '%inboundtransportation%' or concepto ilike '%partnered carrier%'
         or concepto ilike '%removal%' or concepto ilike '%pick%pack%'
         or concepto ilike '%return%'
         or concepto ilike '%weight%handl%'                                 then 'fba'
    when concepto ilike 'ItemFees/%'                                        then 'com'
    when concepto ilike 'Promotion/%' or concepto ilike '%coupon%'          then 'otros'
    when importe < 0                                                        then 'otros'
    else 'ignorar'
  end as cubo,
  -- Sub-etiqueta para separar la tarifa FBA POR VENTA de la logística puntual
  -- (envíos a Amazon, retiradas). Ayuda a explicar por qué el % de FBA sube.
  case
    when concepto ilike '%inboundtransportation%' or concepto ilike '%partnered carrier%'
         or concepto ilike '%removal%' or concepto ilike '%disposal%'       then 'logistica'
    else 'venta'
  end as sub
from settlement_lineas
where fecha is not null;

-- Desglose de un cubo por concepto en un rango (importe NETO de IVA, positivo = coste).
create or replace function pnl_desglose(desde date, hasta date, p_cubo text)
returns table(concepto text, sub text, importe numeric, lineas bigint)
language sql stable as $$
  select concepto,
         max(sub)                          as sub,
         round(-sum(importe) / 1.21, 2)    as importe,
         count(*)::bigint                  as lineas
  from v_settle_desglose
  where fecha >= desde and fecha <= hasta and cubo = p_cubo
  group by concepto
  order by round(-sum(importe) / 1.21, 2) desc;
$$;

-- Comprobar (ver de qué se compone el "FBA" del mes):
-- select * from pnl_desglose(date '2026-07-01', date '2026-07-31', 'fba');
