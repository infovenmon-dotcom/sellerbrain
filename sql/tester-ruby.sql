-- =====================================================================
-- ACCESO TESTER — Ruby (código provisional; "luego se cambia")
-- Ejecuta en Supabase → SQL Editor. (Desactiva la traducción del navegador.)
--
-- Este código NO lleva email: se liga al PRIMER correo con el que se entre.
-- Así Ruby entra con SU email y el código queda ligado solo a ella.
--   · Código de acceso → FBA-RUBY24
--
-- plan = 'tester'  → NO caduca.
-- Re-ejecutar es seguro: si el código ya existe, lo reactiva (no duplica).
-- Para "cambiarlo" luego: basta con dar de alta el código definitivo y
--   desactivar este  ->  update miembros set activo = false where codigo = 'FBA-RUBY24';
-- =====================================================================

insert into miembros (codigo, email, nombre, plan, activo, vitalicio)
values
  ('FBA-RUBY24', null, 'Ruby', 'tester', true, false)
on conflict (codigo) do update
  set nombre = excluded.nombre,
      plan   = excluded.plan,
      activo = excluded.activo;

-- Comprobar:
-- select codigo, email, nombre, plan, activo from miembros where codigo = 'FBA-RUBY24';
