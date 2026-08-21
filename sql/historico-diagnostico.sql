-- =====================================================================
-- DIAGNÓSTICO DE HISTÓRICO DE VENTAS (para la previsión de temporada).
-- Ejecuta en Supabase → SQL Editor. Solo LEE, no cambia nada.
--
-- Nos dice si tenemos ≥13 meses (para comparar "mismo mes del año anterior")
-- o si hay que hacer backfill desde Amazon antes de calcular la estacionalidad.
-- =====================================================================

-- 1) RESUMEN: primera venta, última venta, nº de meses y nº de SKUs.
select
  min(fecha)                                   as primera_venta,
  max(fecha)                                   as ultima_venta,
  count(distinct to_char(fecha,'YYYY-MM'))     as meses_con_datos,
  round(extract(epoch from (max(fecha)-min(fecha)))/86400/30.44, 1) as meses_de_recorrido,
  count(distinct sku)                          as skus_distintos,
  count(*)                                     as filas_totales
from ventas_sku_pais_dia;

-- 2) VENTAS POR MES (unidades y euros). Aquí se ven de un vistazo los picos
--    de temporada (BF/Navidad/Prime Day) y si hay huecos de meses sin datos.
select
  to_char(fecha,'YYYY-MM')      as mes,
  sum(uds)                      as unidades,
  round(sum(ventas)::numeric,0) as euros,
  count(distinct sku)           as skus_con_venta
from ventas_sku_pais_dia
group by 1
order by 1;

-- 3) ¿Cuántos SKUs tienen al menos 13 meses de vida (aptos para comparar
--    interanual con su PROPIO histórico)? El resto usará curva de mercado.
with vida as (
  select sku,
         count(distinct to_char(fecha,'YYYY-MM')) as meses
    from ventas_sku_pais_dia
   group by sku
)
select
  count(*)                                as skus_totales,
  count(*) filter (where meses >= 13)     as skus_con_ano_completo,
  count(*) filter (where meses between 6 and 12) as skus_medio_ano,
  count(*) filter (where meses < 6)       as skus_poco_historico
from vida;

-- Cómo leerlo:
-- · Si "meses_con_datos" ≥ 13 y la consulta 2 muestra noviembre/diciembre del
--   año pasado → podemos calcular estacionalidad real por SKU YA.
-- · Si < 13 meses → hay que ampliar el backfill de Amazon (SP-API, ~2 años atrás)
--   antes de fiarnos de la comparación interanual.
