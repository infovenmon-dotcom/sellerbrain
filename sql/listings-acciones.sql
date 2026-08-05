-- =====================================================================
-- LISTINGS · REGISTRO DE ACCIONES (cerrar/reabrir por país). Cada vez que se
-- cierra o reabre un listing desde SellerBrain se guarda aquí (auditoría).
-- Ejecuta en Supabase. Idempotente.
-- =====================================================================

create table if not exists listings_acciones (
  id      bigint generated always as identity primary key,
  seller  text not null default 'venmon',
  sku     text not null,
  pais    text not null,
  accion  text not null,                -- 'cerrar' | 'reabrir'
  estado  text,                         -- 'ok' | 'error'
  detalle text,                         -- respuesta de Amazon
  fecha   timestamptz default now()
);
alter table listings_acciones enable row level security;

-- Comprobar:
-- select fecha, accion, pais, sku, estado, detalle from listings_acciones order by fecha desc limit 50;
