-- =====================================================================
-- MULTICUENTA · identidad — mapa login → seller.
-- Cada miembro pertenece a UN vendedor (para el aislamiento de lectura, fase 3).
-- El equipo de VENMON queda en 'venmon' (default). Cada vendedor externo llevará
-- su propio seller (su email, igual que cuentas_spapi.seller / la ingesta).
-- Ejecuta en Supabase → SQL Editor. Idempotente. NO cambia el comportamiento
-- actual (el filtro por seller aún no está activado).
-- =====================================================================

alter table miembros add column if not exists seller text default 'venmon';
update miembros set seller = 'venmon' where seller is null;
create index if not exists idx_miembros_seller on miembros (seller);

-- Cuando conectes un vendedor externo, liga su(s) código(s) a su seller:
--   update miembros set seller = 'cliente@ejemplo.com' where email = 'cliente@ejemplo.com';
-- (su seller debe coincidir con cuentas_spapi.seller de su cuenta de Amazon)

-- Comprobar:
-- select seller, count(*) from miembros group by seller;
