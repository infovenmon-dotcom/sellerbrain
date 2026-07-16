-- =====================================================================
-- TAREA 3 — Verificar y blindar el cron nocturno (03:00 UTC)
-- Ejecuta estas consultas en Supabase → SQL Editor.
-- No modifican nada: solo LEEN. Interpretación al final de cada bloque.
-- =====================================================================

-- 1) Últimas ejecuciones registradas (acta del cron).
--    Esperado: filas recientes con origen = 'cron'.
select ejecutada, origen, plan, resumen
from ingestas
order by ejecutada desc
limit 14;

-- 2) ¿Corre CADA noche? Ejecuciones 'cron' por día (últimos 7 días).
--    Esperado: 1 fila por día con ejec_cron = 1.
--    Si algún día falta → ese día el cron NO corrió.
select date(ejecutada)                                   as dia,
       count(*) filter (where origen = 'cron')           as ejec_cron,
       count(*) filter (where origen <> 'cron')          as ejec_manual,
       max(ejecutada)                                     as ultima
from ingestas
where ejecutada >= now() - interval '7 days'
group by 1
order by 1 desc;

-- 3) ¿A qué hora corre? Confirmar que es ~03:00 UTC.
select ejecutada,
       to_char(ejecutada at time zone 'UTC', 'HH24:MI')  as hora_utc
from ingestas
where origen = 'cron'
order by ejecutada desc
limit 7;

-- 4) ppc_dia: números por país en los últimos 5 días.
--    Esperado: valores DISTINTOS por país (cada país su propio gasto/clics).
select fecha, pais, gasto, clics, impresiones, ventas_ppc, pedidos_ppc
from ppc_dia
where fecha >= current_date - 5
order by fecha desc, pais;

-- 5) Detector del bug antiguo de DUPLICADOS.
--    Busca el mismo 'gasto' repetido en varios países el mismo día.
--    Esperado: 0 filas. Si aparecen filas → posible duplicación.
select fecha, gasto,
       count(*)                                   as paises_con_ese_gasto,
       string_agg(pais, ', ' order by pais)       as paises
from ppc_dia
where fecha >= current_date - 15 and gasto > 0
group by fecha, gasto
having count(*) > 1
order by fecha desc;

-- 6) Cobertura: ¿entran los 4 países (ES/FR/IT/BE) cada día?
--    Esperado: paises = 4 cada día.
select fecha,
       count(distinct pais)                       as paises,
       string_agg(distinct pais, ', ' order by pais) as cuales
from ppc_dia
where fecha >= current_date - 7
group by fecha
order by fecha desc;
