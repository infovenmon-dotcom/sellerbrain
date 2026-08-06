-- =====================================================================
-- MAPA PRODUCTO ↔ CAMPAÑA (Sponsored Products). Qué campaña anuncia cada SKU.
-- Lo rellena el Worker con la Ads API (/sp/productAds/list). Sirve para el
-- auto-apagado por baja rentabilidad: si un SKU cae de margen y SOLO lo anuncia
-- UNA campaña, se puede pausar esa (con PPC_AUTOPAUSE=1). Ejecuta en Supabase.
-- =====================================================================

create table if not exists ppc_product_ads (
  seller      text not null default 'venmon',
  pais        text not null,
  campania_id text not null,
  adgroup_id  text,
  sku         text not null default '',
  asin        text,
  estado      text,                 -- ENABLED / PAUSED / ARCHIVED
  fecha       timestamptz,
  primary key (seller, pais, campania_id, sku)
);
alter table ppc_product_ads enable row level security;

-- Comprobar:
-- select sku, count(*) filter (where estado='ENABLED') camp_activas
--   from ppc_product_ads group by sku order by camp_activas desc;
