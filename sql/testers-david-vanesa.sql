-- =====================================================================
-- ACCESO TESTERS — David y su mujer Vanesa (pruebas / feedback)
-- Ejecuta en Supabase → SQL Editor. (Desactiva la traducción del navegador.)
--
-- Cómo entran ellos: en el portal ponen su EMAIL + el CÓDIGO de abajo.
--   · David  → email davidmedielopez@gmail.com     · código FBA-VUKJ6C
--   · Vanesa → email garciavelascovanesa@gmail.com  · código FBA-LDKGFY
--
-- plan = 'tester'  → NO caduca (el trigger solo pone caducidad al plan 'beta').
-- El email ya va ligado al código, así que ese código solo funciona con SU email.
-- Re-ejecutar es seguro: si el código ya existe, lo actualiza (no duplica).
-- =====================================================================

insert into miembros (codigo, email, nombre, plan, activo, vitalicio)
values
  ('FBA-VUKJ6C', 'davidmedielopez@gmail.com',    'David',  'tester', true, false),
  ('FBA-LDKGFY', 'garciavelascovanesa@gmail.com', 'Vanesa', 'tester', true, false)
on conflict (codigo) do update
  set email  = excluded.email,
      nombre = excluded.nombre,
      plan   = excluded.plan,
      activo = excluded.activo;

-- Comprobar que quedaron bien:
-- select codigo, email, nombre, plan, activo, expira::date from miembros
-- where codigo in ('FBA-VUKJ6C','FBA-LDKGFY');
