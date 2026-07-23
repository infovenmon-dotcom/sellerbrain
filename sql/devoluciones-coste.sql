-- =====================================================================
-- Devoluciones = COSTE (nunca ingreso). Ejecuta en Supabase -> SQL Editor.
-- Idempotente. Solo recrea v_settle_clasificado (misma firma de columnas),
-- NO toca v_ventas_dia ni nada de ventas.
--
-- Antes: cualquier linea de tipo "refund" iba a 'dev'. Como una devolucion
-- trae la comision que Amazon te DEVUELVE (positivo) y la tasa de gestion
-- (negativo), el neto salia positivo y "Devoluciones" parecia sumar.
-- Ahora: 'dev' recoge solo los CARGOS de la devolucion (tasa de gestion /
-- logistica). El credito de comision se ignora (la venta bruta no se revierte,
-- asi que ese credito no es un ingreso). Resultado: devoluciones siempre restan.
-- =====================================================================

-- DIAGNOSTICO (opcional) — mira que lineas hay en devoluciones y su signo:
-- select tipo, concepto, count(*), round(sum(importe),2) importe
-- from settlement_lineas
-- where tipo ilike '%refund%'
-- group by tipo, concepto order by importe;

create or replace view v_settle_clasificado as
select
  fecha, sku, importe,
  case
    -- NO son coste: reservas y transferencias (dinero retenido/movido, no gasto).
    when concepto ilike '%reserve%' or tipo ilike '%transfer%'
         or concepto ilike '%balance%'                                      then 'ignorar'
    -- Ingresos / pass-through: precio de venta, IVA del producto, envio cobrado.
    when concepto ilike 'ItemPrice/%'                                       then 'ignorar'
    -- Reembolsos de Amazon a tu favor (perdida/daño de inventario): credito.
    when concepto ilike '%Reimbursement%'                                   then 'ignorar'
    -- Publicidad: se cuenta aparte (Ads API); cubo propio para no doblar.
    when concepto ilike '%Cost of Advertising%' or concepto ilike '%advertising%' then 'ppc'
    -- Devoluciones: SOLO los cargos reales (tasa de gestion del reembolso /
    -- logistica de devolucion). Importe negativo = te lo cobran → coste.
    when tipo ilike '%refund%' and importe < 0                              then 'dev'
    -- Credito de comision de una devolucion (positivo): NO es ingreso porque la
    -- venta bruta no se ha revertido → se ignora para no inflar el beneficio.
    when tipo ilike '%refund%'                                              then 'ignorar'
    -- Almacenaje (storage, incl. su IVA "Tax on fee")
    when concepto ilike '%storage%'                                         then 'alm'
    -- Comision (referral) — incluye RefundCommission
    when concepto ilike '%commission%' or concepto ilike '%referral%'       then 'com'
    -- FBA: cumplimiento por unidad, logistica de entrada, retirada, devolucion
    when concepto ilike '%fulfillment%' or concepto ilike '%fbaperunit%'
         or concepto ilike '%inboundtransportation%' or concepto ilike '%partnered carrier%'
         or concepto ilike '%removal%' or concepto ilike '%pick%pack%'
         or concepto ilike '%return%'   -- tasa de devolucion/gestion logistica de retorno
         or concepto ilike '%weight%handl%'                                 then 'fba'
    -- Resto de ItemFees (servicios digitales, shipping chargeback…) = coste
    when concepto ilike 'ItemFees/%'                                        then 'com'
    -- Promociones / cupones = coste de marketing
    when concepto ilike 'Promotion/%' or concepto ilike '%coupon%'          then 'otros'
    -- Suscripcion, EPR y cualquier otro cargo negativo → 'otros' (coste)
    when importe < 0                                                        then 'otros'
    else 'ignorar'
  end as cubo
from settlement_lineas
where fecha is not null;

-- Comprobar el efecto (dev debe salir NEGATIVO = coste):
-- select cubo, round(sum(importe),2) importe from v_settle_clasificado
-- where fecha >= date_trunc('month', current_date)::date group by cubo order by cubo;
