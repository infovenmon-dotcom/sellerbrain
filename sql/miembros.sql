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

-- IMPORTANTE — la caducidad de la prueba (3 meses):
-- Ejecuta también `sql/miembros-expira.sql`, que hace que `expira` se calcule
-- solo como `alta + 3 meses`. Así el aviso puede saltar al final de la prueba.
-- Para que la fecha sea la REAL de cada miembro, incluye su fecha en la columna
-- `alta` al migrar (ver abajo). Si no la incluyes, `alta` será la de importación.

-- ---------------------------------------------------------------------
-- MIGRACIÓN de la lista actual (Google Sheet -> esta tabla)
--
-- Opción A (recomendada): exporta el Google Sheet a CSV con cabeceras
--   email,codigo,alta
-- (alta = fecha de compra/alta en formato ISO AAAA-MM-DD, p.ej. 2026-07-15).
-- Si no tienes fecha, deja solo  email,codigo  y `alta` se pondrá a la fecha
-- de importación. En Supabase: Table Editor -> miembros -> Insert ->
-- Import data from CSV. (activo=true y plan='beta' se ponen solos.)
--
-- Opción B: insertar a mano (ejemplo, borra estas líneas y pon los tuyos):
-- ---------------------------------------------------------------------
-- insert into miembros (email, codigo, plan, alta) values
--   ('cliente1@ejemplo.com', 'CODIGO1', 'beta', '2026-07-15'),
--   ('cliente2@ejemplo.com', 'CODIGO2', 'beta', '2026-07-16')
-- on conflict (email) do update
--   set codigo = excluded.codigo, activo = true;

-- Comprobar que entraron (y ver cuándo caduca cada prueba):
-- select email, activo, plan, alta::date, expira::date from miembros order by alta desc;
