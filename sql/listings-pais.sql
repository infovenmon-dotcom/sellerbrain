-- =====================================================================
-- LISTINGS POR PAÍS — estado de cada producto en cada marketplace + motivo.
-- Lo rellena el Worker con la Listings Items API (getListingsItem →
-- includedData=summaries,issues), que devuelve el status (BUYABLE…) y los
-- "issues" (el motivo por el que un listing está inactivo/suprimido).
-- Requiere el Merchant Token de la cuenta en la variable SPAPI_SELLER_ID.
-- Ejecuta en Supabase. Idempotente.
-- =====================================================================

create table if not exists listings_pais (
  seller  text not null default 'venmon',
  sku     text not null,
  asin    text,
  pais    text not null,                -- ES, FR, IT, DE, BE…
  estado  text,                         -- 'activo' | 'inactivo' | 'no_publicado'
  motivo  text,                         -- issues de Amazon (por qué está inactivo)
  fecha   timestamptz,
  primary key (seller, sku, pais)
);
alter table listings_pais enable row level security;

-- Comprobar:
-- select pais, estado, count(*) from listings_pais group by pais, estado order by pais;
-- select sku, pais, estado, motivo from listings_pais where estado <> 'activo' order by pais;
