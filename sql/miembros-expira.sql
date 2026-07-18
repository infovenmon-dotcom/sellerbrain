-- =====================================================================
-- TAREA 2 (extra) — Auto-cálculo de la caducidad de la prueba (3 meses)
-- Ejecuta esto DESPUÉS de haber creado la tabla `miembros`.
-- (Si el navegador traduce la página, ponla en original: SQL en inglés.)
--
-- Objetivo: cuando das de alta a un miembro, `expira` se rellena solo con
-- `alta + 3 meses`. Así sabes cuándo termina su prueba para lanzar el aviso.
-- =====================================================================

-- 1) Función que pone expira = alta + 3 meses (solo si no se indicó a mano)
create or replace function set_expira_miembros() returns trigger as $$
begin
  if new.expira is null then
    new.expira := new.alta + interval '3 months';
  end if;
  return new;
end;
$$ language plpgsql;

-- 2) Trigger: se aplica al insertar o actualizar
drop trigger if exists trg_expira_miembros on miembros;
create trigger trg_expira_miembros
  before insert or update on miembros
  for each row execute function set_expira_miembros();

-- 3) Rellenar la caducidad de los miembros que ya existan
update miembros set expira = alta + interval '3 months' where expira is null;

-- 4) Consulta para el AVISO: miembros cuya prueba termina en <= 10 días
--    (esto es lo que alimentará el correo "¿quieres seguir?").
-- select email, alta::date as alta, expira::date as termina,
--        (expira::date - current_date) as dias_restantes
-- from miembros
-- where activo and expira <= now() + interval '10 days'
-- order by expira;
