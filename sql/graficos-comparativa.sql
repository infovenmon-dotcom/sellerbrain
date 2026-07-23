-- =====================================================================
-- Datos para los 2 graficos nuevos del dashboard:
--  A) comparativa dia a dia mes actual vs mismo mes año anterior -> usa la
--     funcion serie_periodo que ya existe (endpoint /v1/serie). No hace falta nada aqui.
--  B) barras mensuales estilo Seller Central (ventas y unidades, por pais).
-- Ejecuta en Supabase -> SQL Editor.
-- =====================================================================

-- Ventas y UNIDADES por mes y pais (base del grafico de barras mensual)
create or replace view v_ventas_mes as
select
  to_char(fecha, 'YYYY-MM') as mes,
  coalesce(nullif(pais,''),'?') as pais,
  round(sum(ventas), 2) as ventas,
  sum(uds)              as uds
from ventas_sku_pais_dia
where fecha is not null
group by 1, 2
order by 1;

-- Comprobar:
-- select * from v_ventas_mes order by mes desc, ventas desc;
