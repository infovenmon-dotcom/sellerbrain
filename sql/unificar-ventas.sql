-- =====================================================================
-- Unificar la fuente de VENTAS: que todo use ventas_sku_pais_dia (la buena,
-- la de la barra / país / tabla de productos) y NO pedidos_dia (que tiene
-- filas antiguas y sobre-cuenta). Ejecuta en Supabase -> SQL Editor.
-- =====================================================================

-- 1) DIAGNOSTICO — comparar las dos fuentes por mes (para ver la diferencia)
select
  coalesce(a.mes, b.mes) as mes,
  a.ventas_pedidos_dia,
  b.ventas_sku_pais
from (
  select to_char(fecha,'YYYY-MM') mes, round(sum(ventas),2) ventas_pedidos_dia
  from pedidos_dia group by 1
) a
full join (
  select to_char(fecha,'YYYY-MM') mes, round(sum(ventas),2) ventas_sku_pais
  from ventas_sku_pais_dia group by 1
) b on a.mes = b.mes
order by 1 desc;

-- 2) EL ARREGLO — v_ventas_dia (que usan tarjetas, P&L, gráfico y serie) pasa a
--    leer de ventas_sku_pais_dia. Con esto, TODO cuadra con la barra.
create or replace view v_ventas_dia as
select
  fecha,
  sku,
  sum(uds)     as uds,
  sum(ventas)  as ventas,
  sum(pedidos) as pedidos
from ventas_sku_pais_dia
group by fecha, sku;

-- 3) Comprobar que ahora cuadran (deben salir iguales):
-- select round(sum(ventas),2) from v_ventas_dia where fecha >= '2026-07-01';
-- select round(sum(ventas),2) from ventas_sku_pais_dia where fecha >= '2026-07-01';
