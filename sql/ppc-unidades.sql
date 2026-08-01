-- =====================================================================
-- PPC · UNIDADES vendidas atribuidas (unitsSoldClicks14d de la Ads API).
-- Ejecuta en Supabase -> SQL Editor. Idempotente.
-- Se rellena con las siguientes ingestas (el histórico previo se queda sin
-- unidades; el dashboard usa pedidos como respaldo cuando no hay unidades).
-- =====================================================================

alter table ppc_campanas add column if not exists unidades_ppc integer default 0;
alter table ppc_dia      add column if not exists unidades_ppc integer default 0;

-- Comprobar tras una ingesta:
-- select fecha, pais, nombre, clics, pedidos_ppc, unidades_ppc, ventas_ppc
--   from ppc_campanas order by fecha desc, gasto desc limit 20;
