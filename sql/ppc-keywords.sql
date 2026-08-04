-- =====================================================================
-- KEYWORDS de Sponsored Products con su puja actual. Lo rellena el Worker con
-- POST /sp/keywords/list (Ads API). Necesario para poder AJUSTAR la puja desde
-- el panel (/v1/ads/puja). Ejecuta en Supabase.
-- =====================================================================

create table if not exists ppc_keywords (
  seller       text not null default 'venmon',
  keyword_id   text not null,
  pais         text,
  campania_id  text,
  adgroup_id   text,
  keyword      text,
  concordancia text,              -- EXACT / PHRASE / BROAD
  puja         numeric,           -- puja actual (bid)
  estado       text,              -- ENABLED / PAUSED / ...
  fecha        timestamptz,
  primary key (seller, keyword_id)
);

alter table ppc_keywords enable row level security;

-- Comprobar:
-- select keyword, concordancia, puja, estado from ppc_keywords order by fecha desc limit 50;
