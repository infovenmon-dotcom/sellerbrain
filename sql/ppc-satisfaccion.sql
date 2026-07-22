-- =====================================================================
-- v10 · PPC desacoplado + Satisfacción del cliente
-- Ejecuta en Supabase → SQL Editor (mejor en pestaña de incógnito para
-- evitar el fallo de la traducción automática de Chrome).
-- Es seguro re-ejecutar: usa "if not exists" y "create or replace".
-- =====================================================================

-- 1) COLA DE INFORMES PPC PENDIENTES ----------------------------------
--    Los informes de Amazon Ads pueden tardar >4 min. Guardamos su id aquí
--    y una "pasada de recogida" (botón /v1/ppc/recoger o el cron) los ingesta
--    en cuanto Amazon los tiene listos. Así el PPC entra SIEMPRE.
create table if not exists ppc_pendientes (
  report_id text primary key,          -- id del informe en Amazon Ads
  pais      text not null,             -- ES / FR / IT
  tipo      text not null,             -- 'dia' | 'terminos'
  fecha     text,                      -- para tipo 'dia' (YYYY-MM-DD)
  desde     text,                      -- para tipo 'terminos'
  hasta     text,                      -- para tipo 'terminos'
  creado    timestamptz not null default now()
);
alter table ppc_pendientes enable row level security;

-- 2) SATISFACCIÓN DEL CLIENTE POR PRODUCTO ----------------------------
--    Amazon NO da las reseñas por API. Lo único oficial que sí manda es el
--    MOTIVO de cada devolución → lo usamos como señal de satisfacción real.
--    Clasificamos cada devolución en:
--      · crítico   → problema del PRODUCTO (defecto, calidad, no era lo descrito)
--                    = lo que suele acabar en una reseña de 1-2★
--      · logística → daño en transporte / centro logístico (no es el producto)
--      · neutro    → cambio de opinión, pedido equivocado, mejor precio…
--    "estrellas_est" es un PROXY orientativo (no la reseña real de Amazon).
create or replace view v_satisfaccion_producto as
with d as (
  select
    sku,
    upper(coalesce(motivo, '')) as motivo,
    coalesce(cantidad, 1)       as cantidad
  from devoluciones
  where sku is not null and sku <> '' and sku not ilike 'amzn.gr.%'
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
)
select
  sku,
  sum(cantidad)::int                                        as devoluciones,
  sum(cantidad) filter (where bucket = 'critico')::int      as criticas,
  sum(cantidad) filter (where bucket = 'logistica')::int    as logistica,
  sum(cantidad) filter (where bucket = 'neutro')::int       as neutras,
  round(100.0 * sum(cantidad) filter (where bucket = 'critico')
        / nullif(sum(cantidad), 0), 0)                      as pct_criticas,
  -- 5★ menos penalización proporcional a las devoluciones de calidad
  greatest(1.0, round(5 - 4.0 * sum(cantidad) filter (where bucket = 'critico')
        / nullif(sum(cantidad), 0), 1))                     as estrellas_est,
  mode() within group (order by motivo)                     as motivo_top,
  case
    when sum(cantidad) filter (where bucket = 'critico') >= 2
      or (sum(cantidad) filter (where bucket = 'critico') > 0
          and sum(cantidad) filter (where bucket = 'critico') * 2 >= sum(cantidad))
      then 'rojo'
    when sum(cantidad) filter (where bucket = 'critico') > 0
      then 'ambar'
    else 'verde'
  end                                                        as senal
from clas
group by sku;

-- Comprobar:
-- select * from v_satisfaccion_producto order by criticas desc, devoluciones desc;
