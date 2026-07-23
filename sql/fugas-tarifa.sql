-- =====================================================================
-- DETECTOR DE FUGAS DE TARIFA (cross-border) — por SKU y pais.
-- Ejecuta en Supabase -> SQL Editor. Idempotente.
--
-- Idea: si una parte de tus unidades se sirve desde otro pais (transfronterizo),
-- pagas una tarifa de gestion mas cara que la local. Comparamos la tarifa MEDIA
-- que pagas contra tu MEJOR tarifa (proxy de la local = percentil 15) y sacamos
-- cuanto dinero se va por servir fuera de pais. Base para una accion con € reales:
-- "mete stock en ES para KC-... -> +X€/mes".
--
-- Las tarifas del settlement vienen CON IVA -> se dividen por 1,21 (IVA recuperable).
-- Cada linea de gestion ~ 1 unidad (asi lo confirma el settlement).
-- =====================================================================

create or replace view v_fuga_tarifa as
with lineas as (
  select
    sku,
    coalesce(nullif(pais,''),'?') as pais,
    abs(importe) / 1.21 as fee            -- tarifa por unidad, SIN IVA
  from settlement_lineas
  where importe < 0
    and coalesce(sku,'') <> ''
    and fecha >= (current_date - 90)      -- ventana de 90 dias
    and ( concepto ilike '%fulfillment%' or concepto ilike '%fbaperunit%'
       or concepto ilike '%weight%handl%' )
),
bench as (
  select
    sku, pais,
    count(*)                                                     as uds,
    round(avg(fee), 2)                                           as fee_medio,
    round(percentile_cont(0.15) within group (order by fee), 2) as fee_local,  -- tu mejor tarifa (≈ local)
    round(max(fee), 2)                                           as fee_max
  from lineas
  group by sku, pais
),
det as (
  select l.sku, l.pais,
    count(*) filter (where l.fee > b.fee_local * 1.10) as uds_caras   -- servidas >10% por encima de la local
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
