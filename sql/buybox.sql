-- =====================================================================
-- BUY BOX / competencia por ASIN. Lo rellena el Worker con la SP-API Product
-- Pricing (getItemOffers, rol "Pricing"). Un registro por vendedor + ASIN,
-- refrescado a diario (05:00 UTC) y con el botón admin. Ejecuta en Supabase.
-- =====================================================================

create table if not exists buybox (
  seller         text not null default 'venmon',
  asin           text not null,
  sku            text,
  nombre         text,
  tengo_buybox   boolean,              -- ¿la Buy Box es tuya?
  buybox_precio  numeric,              -- precio (landed) de la Buy Box
  mi_precio      numeric,              -- tu precio (landed) para ese ASIN
  min_competidor numeric,             -- oferta más barata de un competidor (landed)
  n_ofertas      int,                  -- nº total de ofertas del ASIN
  moneda         text default 'EUR',
  fecha          timestamptz,          -- momento del snapshot
  primary key (seller, asin)
);

-- RLS: solo el Worker (service key) la escribe/lee.
alter table buybox enable row level security;

-- Comprobar:
-- select asin, sku, tengo_buybox, mi_precio, buybox_precio, min_competidor, n_ofertas, fecha
-- from buybox order by tengo_buybox asc, fecha desc;
