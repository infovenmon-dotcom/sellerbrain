-- =====================================================================
-- KEYWORDS · RENDIMIENTO + puja sugerida. Añade a ppc_keywords las métricas
-- por palabra (clics, gasto, ventas, pedidos) del informe de Ads (spKeywords),
-- para poder calcular una PUJA SUGERIDA según el ACoS objetivo. Ejecuta en Supabase.
-- =====================================================================

alter table ppc_keywords add column if not exists clics       int;
alter table ppc_keywords add column if not exists gasto       numeric;
alter table ppc_keywords add column if not exists ventas      numeric;
alter table ppc_keywords add column if not exists pedidos     int;
alter table ppc_keywords add column if not exists impresiones int;

-- Comprobar:
-- select keyword, clics, gasto, ventas, pedidos, puja from ppc_keywords
--   where clics is not null order by gasto desc nulls last limit 50;
