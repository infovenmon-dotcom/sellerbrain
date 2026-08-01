-- =====================================================================
-- DETECTOR DE FUGAS DE TARIFA (cross-border) — por SKU y PAÍS DE SALIDA.
-- Ejecuta en Supabase -> SQL Editor DESPUÉS de sql/envios-fc.sql. Idempotente.
--
-- Idea: si una parte de tus unidades se sirve desde otro país (transfronterizo),
-- pagas una tarifa de gestión más cara que la LOCAL de ese país. Comparamos la
-- tarifa MEDIA que pagas contra tu mejor tarifa observada EN ESE MISMO PAÍS
-- (proxy de la local del país = percentil 15) y sacamos cuánto dinero se va.
--
-- NUEVO (país fiable): antes intentábamos adivinar el país de cada tarifa desde el
-- propio settlement, que muchas veces NO lo trae -> salía '?'. Ahora tomamos el
-- PAÍS DE SALIDA real del Informe de Envíos (tabla envios_fc), cruzando por order-id.
-- Así el benchmark local es por país de salida y desaparece el 'sin determinar'.
--
-- Las tarifas del settlement vienen CON IVA -> se dividen por 1,21 (IVA recuperable).
-- Cada línea de gestión ~ 1 unidad (así lo confirma el settlement).
-- =====================================================================

create or replace view v_fuga_tarifa as
with paisped as (                          -- país de SALIDA por pedido (del informe de envíos)
  select order_id as pedido, max(pais_salida) as pais
  from envios_fc
  where coalesce(pais_salida,'') not in ('', '?')
  group by order_id
),
lineas as (
  select
    l.sku,
    -- país de SALIDA real (envios_fc); si no hay match, el de la línea; si tampoco, '?'
    coalesce(p.pais, nullif(l.pais,''), '?') as pais,
    abs(l.importe) / 1.21 as fee            -- tarifa por unidad, SIN IVA
  from settlement_lineas l
  left join paisped p on p.pedido = l.pedido
  where l.importe < 0
    and coalesce(l.sku,'') <> ''
    and l.fecha >= (current_date - 90)      -- ventana de 90 días
    and ( l.concepto ilike '%fulfillment%' or l.concepto ilike '%fbaperunit%'
       or l.concepto ilike '%weight%handl%' )
),
bench as (
  select
    sku, pais,
    count(*)                                                     as uds,
    round(avg(fee), 2)                                           as fee_medio,
    round((percentile_cont(0.15) within group (order by fee))::numeric, 2) as fee_local,  -- mejor tarifa EN ESE PAÍS (≈ local del país)
    round(max(fee), 2)                                           as fee_max
  from lineas
  where pais <> '?'                          -- sin país conocido no comparamos (evita el falso "local de ES")
  group by sku, pais
),
det as (
  select l.sku, l.pais,
    count(*) filter (where l.fee > b.fee_local * 1.10) as uds_caras   -- servidas >10% por encima de la local del país
  from lineas l
  join bench b on b.sku = l.sku and b.pais = l.pais
  group by l.sku, l.pais
)
select
  b.sku, b.pais, b.uds, b.fee_medio, b.fee_local, b.fee_max,
  d.uds_caras,
  round(100.0 * d.uds_caras / nullif(b.uds, 0), 0)              as pct_caras,
  round((b.fee_medio - b.fee_local) * b.uds, 2)                 as sobrecoste_90d,
  round((b.fee_medio - b.fee_local) * b.uds / 3.0, 2)          as sobrecoste_mes
from bench b
join det d on d.sku = b.sku and d.pais = b.pais
where b.uds >= 10                                    -- suficientes unidades para fiarse
  and (b.fee_medio - b.fee_local) * b.uds >= 5       -- solo fugas con algo de miga
order by sobrecoste_mes desc;

-- Comprobar:
-- select * from v_fuga_tarifa order by sobrecoste_mes desc;
-- Cobertura del país de salida (debería haber muy pocos '?' si envios_fc está cargado):
-- select coalesce(nullif(pais,''),'(vacio)') pais, count(*) from v_fuga_tarifa group by 1 order by 2 desc;
