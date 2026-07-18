-- =====================================================================
-- TAREA 2 — Login propio · tabla de miembros (clave = CÓDIGO)
-- Ejecuta en Supabase → SQL Editor. (Desactiva la traducción del navegador.)
--
-- Modelo: la clave es el CÓDIGO (único, siempre presente). El email puede ir
-- VACÍO: son códigos aún sin asignar (pruebas gratis / feedback — David y su
-- mujer, testers, etc.). El email se rellena solo cuando la persona entra por
-- primera vez con ese código. Una persona puede tener varios códigos.
--
-- Seguro re-ejecutar: recrea la tabla (ahora está vacía). El aviso de
-- "operación destructiva" es por el DROP de una tabla vacía; no pierdes datos.
-- =====================================================================

drop table if exists miembros cascade;

create table miembros (
  codigo    text primary key,        -- clave: el código de acceso (único)
  email     text,                     -- se rellena al primer login; puede repetirse
  nombre    text,
  activo    boolean not null default true,
  plan      text default 'beta',      -- 'beta' (de pago, caduca 3m) · 'creador'/'equipo' (no caducan)
  vitalicio boolean not null default false, -- true = acceso de por vida (nunca caduca)
  alta      timestamptz not null default now(),
  expira    timestamptz               -- se autocalcula abajo
);

-- Seguridad: invisible desde el navegador; solo el Worker (service key) lee.
alter table miembros enable row level security;
create index if not exists idx_miembros_email on miembros (email);

-- Auto-caducidad: SOLO los 'beta' (de pago) caducan a los 3 meses.
-- Los de plan 'equipo'/'gratis' NO caducan (su expira queda en null).
create or replace function set_expira_miembros() returns trigger as $$
begin
  if new.vitalicio then
    new.expira := null;                                    -- vitalicio = nunca caduca
  elsif new.expira is null and coalesce(new.plan, 'beta') = 'beta' then
    new.expira := new.alta + interval '3 months';          -- beta = 3 meses
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_expira_miembros on miembros;
create trigger trg_expira_miembros
  before insert or update on miembros
  for each row execute function set_expira_miembros();

-- ---------------------------------------------------------------------
-- MIGRACIÓN: Table Editor -> miembros -> Insert -> Import data from CSV
-- Tu CSV vale TAL CUAL. Cabeceras: email,codigo,alta,nombre
--   - codigo  : obligatorio (es la clave)
--   - email   : puede ir vacío (código sin asignar)
--   - alta    : la columna 'fecha' del Sheet (ISO 'AAAA-MM-DD HH:MM:SS')
--   - nombre  : opcional
-- expira se calcula sola. No la incluyas.
-- ---------------------------------------------------------------------

-- Marcar a alguien como EQUIPO / GRATIS (no caduca) tras importar:
-- update miembros set plan = 'equipo', expira = null where codigo = 'FBA-XXXX';

-- Ver el estado:
-- select codigo, email, nombre, plan, alta::date, expira::date
-- from miembros order by alta;
