-- =====================================================================
-- BUY BOX / competencia por SKU. Lo rellena el Worker con la SP-API Product
-- Pricing (getListingOffers por TU SKU, rol "Pricing"). Un registro por
-- vendedor + SKU, refrescado a diario (05:00 UTC) y con el botón admin.
-- Usamos getListingOffers (por SKU) y NO getItemOffers (por ASIN) porque el
-- primero SÍ marca de forma fiable cuál es TU oferta (MyOffer). Ejecuta en Supabase.
-- =====================================================================

-- Migración: antes la PK era (seller, asin). Ahora indexamos por SKU (getListingOffers).
-- Como es un snapshot que el Worker reconstruye a diario, lo recreamos limpio.
drop table if exists buybox;

create table if not exists buybox (
  seller         text not null default 'venmon',
  sku            text not null,
  asin           text,
  nombre         text,
  tengo_buybox   boolean,              -- ¿la Buy Box es tuya? (null = sin dato)
  buybox_precio  numeric,              -- precio (landed) de la Buy Box
  mi_precio      numeric,              -- tu precio (landed) para ese SKU
  min_competidor numeric,             -- oferta más barata de un competidor (landed); null si eres el único vendedor
  n_ofertas      int,                  -- nº total de ofertas del listing
  moneda         text default 'EUR',
  fecha          timestamptz,          -- momento del snapshot
  primary key (seller, sku)
);

-- RLS: solo el Worker (service key) la escribe/lee.
alter table buybox enable row level security;

-- Comprobar:
-- select sku, asin, tengo_buybox, mi_precio, buybox_precio, min_competidor, n_ofertas, fecha
-- from buybox order by tengo_buybox asc nulls last, fecha desc;
