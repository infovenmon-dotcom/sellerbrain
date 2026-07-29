-- =====================================================================
-- STRIPE — alta automática de miembros al pagar. Ejecuta en Supabase → SQL Editor.
-- El Worker recibe el webhook de Stripe, verifica la firma y crea el miembro.
-- Esta tabla evita procesar dos veces el mismo evento (Stripe reintenta).
-- =====================================================================

create table if not exists stripe_eventos (
  id     text primary key,          -- id del evento de Stripe (evt_...)
  email  text,
  codigo text,                       -- código de acceso generado para ese pago
  creado timestamptz default now()
);
alter table stripe_eventos enable row level security;

-- Comprobar:
-- select * from stripe_eventos order by creado desc;
-- select codigo, email, plan, seller, alta from miembros order by alta desc;
