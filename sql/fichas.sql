-- =====================================================================
-- VIGILANCIA DE FICHA / HIJACKING. Snapshot del título (e imagen) de cada ASIN.
-- El Worker lo actualiza a diario (Catalog Items API). Si el título cambia entre
-- ejecuciones, guarda el título anterior y la fecha del cambio → posible edición
-- no autorizada / hijack. Ejecuta en Supabase.
-- =====================================================================

create table if not exists fichas (
  seller       text not null default 'venmon',
  asin         text not null,
  sku          text,
  titulo       text,               -- título actual de la ficha
  imagen       text,               -- imagen principal actual
  titulo_prev  text,               -- título anterior (si cambió)
  cambio_fecha timestamptz,        -- cuándo se detectó el último cambio de título
  fecha        timestamptz,        -- última comprobación
  primary key (seller, asin)
);

alter table fichas enable row level security;

-- Comprobar (cambios recientes):
-- select asin, sku, titulo, titulo_prev, cambio_fecha
-- from fichas where cambio_fecha is not null order by cambio_fecha desc;
