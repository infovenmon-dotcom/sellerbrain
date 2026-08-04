-- =====================================================================
-- SEARCH QUERY PERFORMANCE (SQP) — Brand Analytics. Por cada búsqueda: volumen
-- de mercado y TU cuota en cada paso del embudo (impresiones → clics → compras).
-- Sirve para ver dónde pierdes cuota en búsquedas con mucho volumen. Semanal.
-- Ejecuta en Supabase.
-- =====================================================================

create table if not exists busquedas_sqp (
  seller         text not null default 'venmon',
  semana         date not null,           -- inicio de la semana del informe
  query          text not null,           -- término de búsqueda del cliente
  volumen        numeric,                 -- volumen de la búsqueda (mercado)
  imp_share      numeric,                 -- tu cuota de impresiones (0-1 o %)
  click_share    numeric,                 -- tu cuota de clics
  purchase_share numeric,                 -- tu cuota de compras
  compras_total  numeric,                 -- compras totales del mercado para esa búsqueda
  fecha          timestamptz,
  primary key (seller, semana, query)
);

alter table busquedas_sqp enable row level security;

-- Comprobar:
-- select query, volumen, imp_share, click_share, purchase_share
-- from busquedas_sqp order by volumen desc nulls last limit 50;
