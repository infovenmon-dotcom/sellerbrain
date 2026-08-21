-- =====================================================================
-- ESTACIONALIDAD + TENDENCIA por SKU (para la previsión de stock).
-- Ejecuta en Supabase → SQL Editor. Seguro re-ejecutar (crea/reemplaza la función).
--
-- Devuelve, por producto:
--   · factores[1..12] → cuánto sube/baja cada mes del año (1,0 = su media).
--     Se calcula dividiendo las ventas de cada mes entre la MEDIA de su propio
--     año → así queda solo la FORMA de la temporada, sin el crecimiento (que se
--     mide aparte con la tendencia). Si el SKU tiene poco histórico, usa la
--     CURVA DEL CATÁLOGO (todos los productos juntos) como plan B.
--   · tendencia → últimos 3 meses COMPLETOS de este año ÷ los mismos 3 del año
--     pasado (acotada entre 0,5 y 3). >1 = en alza, <1 = a la baja.
--   · meses_vida y confianza (alta/media/baja) según recorrido del SKU.
--
-- El worker usa: venta_media_ajustada = venta_base × factores[mes_que_viene] × tendencia
-- =====================================================================

create or replace function estacionalidad_sku()
returns table (
  sku        text,
  meses_vida int,
  tendencia  numeric,
  confianza  text,
  factores   numeric[]   -- 12 valores: [1]=enero … [12]=diciembre
) language sql stable as $$
  with
  -- ventas por SKU · año · mes
  base as (
    select sku,
           extract(year  from fecha)::int as anio,
           extract(month from fecha)::int as mes,
           sum(uds)::numeric              as uds
      from ventas_sku_pais_dia
     group by sku, extract(year from fecha)::int, extract(month from fecha)::int
  ),
  -- años COMPLETOS por SKU (>=12 meses con dato) → patrón estacional limpio
  anio_ok as (
    select sku, anio from base group by sku, anio having count(*) >= 12
  ),
  media_anual as (
    select b.sku, b.anio, avg(b.uds) as media
      from base b join anio_ok a on a.sku = b.sku and a.anio = b.anio
     group by b.sku, b.anio
  ),
  factor_sku as (   -- factor del SKU = media (entre años completos) de uds/media_del_año
    select b.sku, b.mes, avg(b.uds / nullif(m.media,0)) as factor
      from base b join media_anual m on m.sku = b.sku and m.anio = b.anio
     group by b.sku, b.mes
  ),
  -- CURVA DE CATÁLOGO (todos los SKU juntos) como plan B para poco histórico
  base_cat as (
    select extract(year from fecha)::int as anio,
           extract(month from fecha)::int as mes,
           sum(uds)::numeric as uds
      from ventas_sku_pais_dia group by 1, 2
  ),
  anio_cat_ok as (select anio from base_cat group by anio having count(*) >= 12),
  media_cat   as (select bc.anio, avg(bc.uds) as media
                    from base_cat bc join anio_cat_ok a on a.anio = bc.anio group by bc.anio),
  factor_cat  as (select bc.mes, avg(bc.uds / nullif(mc.media,0)) as factor
                    from base_cat bc join media_cat mc on mc.anio = bc.anio group by bc.mes),
  -- meses de vida por SKU
  vida as (select sku, count(*) as meses from base group by sku),
  -- factores completos (1..12) por SKU, con plan B de catálogo y 1,0 por defecto
  factores_full as (
    select v.sku, m.mes,
           round(coalesce(fs.factor, fc.factor, 1)::numeric, 3) as factor
      from vida v
      cross join generate_series(1,12) as m(mes)
      left join factor_sku fs on fs.sku = v.sku and fs.mes = m.mes
      left join factor_cat fc on fc.mes = m.mes
  ),
  factores_arr as (
    select sku, array_agg(factor order by mes) as factores
      from factores_full group by sku
  ),
  -- TENDENCIA: 3 meses COMPLETOS más recientes (excluye el mes en curso) vs los
  -- mismos 3 meses del año anterior.
  per as (
    select date_trunc('month', current_date)                       as mes_curso,
           date_trunc('month', current_date) - interval '3 months' as ini_act,
           date_trunc('month', current_date) - interval '15 months' as ini_prev,
           date_trunc('month', current_date) - interval '12 months' as fin_prev
  ),
  trend as (
    select d.sku,
      sum(d.uds) filter (where d.fecha >= p.ini_act  and d.fecha < p.mes_curso) as u_act,
      sum(d.uds) filter (where d.fecha >= p.ini_prev and d.fecha < p.fin_prev)  as u_prev
    from ventas_sku_pais_dia d cross join per p
    group by d.sku
  )
  select
    v.sku,
    v.meses::int as meses_vida,
    greatest(0.5, least(3.0,
      case when coalesce(t.u_prev,0) > 0 then round(t.u_act::numeric / t.u_prev, 3) else 1 end
    )) as tendencia,
    case when v.meses >= 13 then 'alta' when v.meses >= 6 then 'media' else 'baja' end as confianza,
    fa.factores
  from vida v
  left join trend t        on t.sku  = v.sku
  left join factores_arr fa on fa.sku = v.sku;
$$;

-- COMPROBAR (previsualiza los factores de tus productos con más venta):
-- select sku, confianza, meses_vida, tendencia,
--        factores[11] as factor_noviembre, factores[12] as factor_diciembre
--   from estacionalidad_sku()
--  order by tendencia desc
--  limit 20;
--
-- Curva del catálogo (la forma de temporada global, plan B):
-- select factores from estacionalidad_sku() limit 1;   -- (cualquier SKU sin histórico la hereda)
