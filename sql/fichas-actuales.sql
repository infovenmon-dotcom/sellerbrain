-- =====================================================================
-- FICHA ACTUAL cacheada (título + bullets + descripción + imágenes) por SKU.
-- Ejecuta en Supabase → SQL Editor. Seguro re-ejecutar.
--
-- Por qué: pedir la ficha a Amazon en cada clic hace hasta 7 llamadas y Amazon
-- LIMITA (throttling) tras varias seguidas → dejaba de devolver nada. Con esta
-- tabla, cada producto se pide a Amazon UNA vez, se guarda aquí, y a partir de
-- ahí sale al instante desde tu base (la Auditoría y el Generador la comparten).
-- =====================================================================

create table if not exists fichas_actuales (
  seller      text not null default 'venmon',
  sku         text not null,
  asin        text default '',
  title       text default '',
  bullets     jsonb default '[]'::jsonb,
  description text default '',
  imagen      text default '',
  imagenes    jsonb default '[]'::jsonb,
  actualizado timestamptz default now(),
  primary key (seller, sku)
);

alter table fichas_actuales enable row level security;

-- Comprobar:
-- select sku, asin, jsonb_array_length(bullets) bullets, jsonb_array_length(imagenes) imgs, actualizado
--   from fichas_actuales order by actualizado desc limit 20;
