-- =====================================================================
-- DIAGNÓSTICO DE HISTÓRICO DE VENTAS (para la previsión de temporada).
-- Ejecuta en Supabase → SQL Editor. Solo LEE, no cambia nada.
--
-- Nos dice si tenemos ≥13 meses (para comparar "mismo mes del año anterior")
-- o si hay que hacer backfill desde Amazon antes de calcular la estacionalidad.
--
-- NOTA: no uses el endpoint /v1/backfill-estado para esto — solo lee las
-- primeras 1.000 filas (tope de PostgREST) y subcuenta los meses. Estas
-- consultas suman en el servidor sobre TODA la tabla, así que son las fiables.
-- =====================================================================

-- 0) LA IMPORTANTE: cobertura por mes en las DOS tablas de ventas a la vez.
--    ventas_sku_pais_dia = tabla nueva por país · pedidos_dia = histórico antiguo.
--    Un mes por fila, y al lado las unidades en cada tabla → se ve hasta dónde
--    llega cada una y si tenemos nov/dic 2025 (para Black Friday / Navidad).
select
  to_char(fecha,'YYYY-MM')                          as mes,
  sum(uds) filter (where t = 'pais')                as uds_ventas_sku_pais_dia,
  sum(uds) filter (where t = 'ped')                 as uds_pedidos_dia
from (
  select fecha, uds,             'pais'::text as t from ventas_sku_pais_dia
  union all
  select fecha, unidades as uds, 'ped'::text  as t from pedidos_dia   -- pedidos_dia usa 'unidades', no 'uds'
) x
group by 1
order by 1;

-- 1) RESUMEN de la tabla nueva (por país).
select
  min(fecha)                                   as primera_venta,
  max(fecha)                                   as ultima_venta,
  count(distinct to_char(fecha,'YYYY-MM'))     as meses_con_datos,
  round((max(fecha) - min(fecha))::numeric / 30.44, 1) as meses_de_recorrido,
  count(distinct sku)                          as skus_distintos,
  count(*)                                     as filas_totales
from ventas_sku_pais_dia;

-- 1b) RESUMEN del histórico antiguo (pedidos_dia, sin país) por si tiene más recorrido.
select
  min(fecha)                                   as primera_venta,
  max(fecha)                                   as ultima_venta,
  count(distinct to_char(fecha,'YYYY-MM'))     as meses_con_datos,
  count(distinct sku)                          as skus_distintos,
  count(*)                                     as filas_totales
from pedidos_dia;

-- 2) VENTAS POR MES (tabla nueva). Aquí se ven los picos de temporada.
select
  to_char(fecha,'YYYY-MM')      as mes,
  sum(uds)                      as unidades,
  round(sum(ventas)::numeric,0) as euros,
  count(distinct sku)           as skus_con_venta
from ventas_sku_pais_dia
group by 1
order by 1;

-- 3) ¿Cuántos SKUs tienen ya un año completo (aptos para comparar interanual
--    con su PROPIO histórico)? El resto usará curva de mercado.
with vida as (
  select sku, count(distinct to_char(fecha,'YYYY-MM')) as meses
    from ventas_sku_pais_dia
   group by sku
)
select
  count(*)                                        as skus_totales,
  count(*) filter (where meses >= 13)             as skus_con_ano_completo,
  count(*) filter (where meses between 6 and 12)  as skus_medio_ano,
  count(*) filter (where meses < 6)               as skus_poco_historico
from vida;

-- Cómo leerlo:
-- · Si la consulta 0/2 llega a ≥13 meses e incluye 2025-11 y 2025-12 con datos
--   → podemos calcular estacionalidad real por SKU YA.
-- · Si se queda corta o falta lo reciente → ampliar el backfill de Amazon
--   (SP-API, ~2 años atrás) antes de fiarnos de la comparación interanual.
