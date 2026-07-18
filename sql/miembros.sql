-- =====================================================================
-- TAREA 2 — Login propio en el Worker · tabla de miembros
-- Ejecuta en Supabase → SQL Editor. (Recuerda: si el navegador te traduce
-- la página, ponla en original — el SQL debe estar en inglés.)
--
-- Los códigos NO serán legibles desde el navegador: RLS bloquea la clave
-- pública; solo el Worker (service key) puede leer esta tabla.
-- =====================================================================

create table if not exists miembros (
  email   text primary key,
  codigo  text not null,
  activo  boolean not null default true,
  plan    text default 'beta',
  alta    timestamptz not null default now(),
  expira  timestamptz            -- null = sin caducidad
);

-- Seguridad a nivel de fila: la clave pública (anon) no lee ni escribe.
-- No creamos políticas para 'anon': el Worker usa la service key, que salta
-- RLS. Así la tabla queda invisible desde el navegador.
alter table miembros enable row level security;

-- Índice para acelerar el login (por email de miembros activos).
create index if not exists idx_miembros_email_activo on miembros (email) where activo;

-- ---------------------------------------------------------------------
-- MIGRACIÓN de la lista actual (Google Sheet -> esta tabla)
--
-- Opción A (recomendada): exporta el Google Sheet a CSV con cabeceras
--   email,codigo
-- y en Supabase: Table Editor -> miembros -> Insert -> Import data from CSV.
-- (activo se pone en true solo; plan queda 'beta' por defecto.)
--
-- Opción B: insertar a mano (ejemplo, borra estas líneas y pon los tuyos):
-- ---------------------------------------------------------------------
-- insert into miembros (email, codigo, plan) values
--   ('cliente1@ejemplo.com', 'CODIGO1', 'beta'),
--   ('cliente2@ejemplo.com', 'CODIGO2', 'beta')
-- on conflict (email) do update
--   set codigo = excluded.codigo, activo = true;

-- Comprobar que entraron:
-- select email, activo, plan, expira from miembros order by alta desc;
