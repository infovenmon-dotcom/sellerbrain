-- =====================================================================
-- FIX: la tabla `reembolsos` no tiene columna `seller` (quedó fuera de la
-- migración multicuenta), pero el Worker escribe `seller` en cada fila ->
-- error "Could not find the 'seller' column of 'reembolsos'".
-- Añade la columna (default 'venmon') + índice, como el resto de tablas.
-- Ejecuta en Supabase → SQL Editor. Idempotente.
-- =====================================================================
alter table reembolsos add column if not exists seller text default 'venmon';
update reembolsos set seller = 'venmon' where seller is null;
create index if not exists idx_reembolsos_seller on reembolsos (seller);

-- Comprobar:
-- select seller, count(*) from reembolsos group by seller;
