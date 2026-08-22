-- =====================================================================
-- LISTA DE ESPERA (pre-lanzamiento). Ejecuta en Supabase → SQL Editor.
-- Seguro re-ejecutar.
--
-- Guarda los emails de los interesados que se apuntan desde la landing
-- mientras las ventas están cerradas. El email es la clave primaria → si
-- alguien se apunta dos veces, NO se duplica (se queda la fecha original).
-- =====================================================================

create table if not exists lista_espera (
  email  text primary key,               -- email en minúsculas (lo normaliza el worker)
  origen text default 'landing',          -- de dónde vino (por si hay varias fuentes)
  nota   text default '',
  creado timestamptz default now()
);

alter table lista_espera enable row level security;

-- Ver los interesados (más recientes primero):
-- select email, origen, creado from lista_espera order by creado desc;
--
-- Cuántos hay:
-- select count(*) from lista_espera;
