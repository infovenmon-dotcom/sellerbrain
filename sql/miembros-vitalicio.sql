-- =====================================================================
-- Añadir "vitalicio" (acceso de por vida) a la tabla miembros YA existente.
-- Ejecuta en Supabase → SQL Editor. No borra datos. (Traducción del
-- navegador desactivada.)
-- =====================================================================

-- 1) Nueva columna: por defecto false (nadie es vitalicio hasta marcarlo).
alter table miembros add column if not exists vitalicio boolean not null default false;

-- 2) Actualizar la regla de caducidad para que respete 'vitalicio'.
--    (Reemplaza la función; el trigger existente la usa automáticamente.)
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

-- 3) (Opcional) marcar como vitalicios a quien quieras, por código:
-- update miembros set vitalicio = true where codigo in ('FBA-XXXX','FBA-YYYY');

-- Ver estado:
-- select codigo, email, nombre, plan, vitalicio, expira::date from miembros order by alta;
