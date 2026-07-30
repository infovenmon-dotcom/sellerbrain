-- =====================================================================
-- FEEDBACK — respuestas del formulario de seguimiento (encuesta E-15).
-- Ejecuta en Supabase → SQL Editor. Idempotente.
-- El Worker recibe POST /v1/feedback (público) y guarda aquí; la vista de
-- análisis (admin-feedback.html) lee GET /v1/feedback con la clave admin.
-- =====================================================================

create table if not exists feedback (
  id     bigint generated always as identity primary key,
  email  text,
  seller text,
  ayuda  text,                 -- ¿Qué es lo que más te ayuda?
  mejora text,                 -- ¿Qué te falta o cambiarías?
  nps    int,                  -- Del 0 al 10, ¿lo recomendarías?
  creado timestamptz default now()
);
alter table feedback enable row level security;
create index if not exists idx_feedback_creado on feedback (creado desc);

-- Comprobar:
-- select creado, email, nps, left(ayuda,40) as ayuda, left(mejora,40) as mejora
--   from feedback order by creado desc;
-- select round(avg(nps),1) as nps_medio, count(*) filter (where nps>=9) as promotores,
--        count(*) filter (where nps<=6) as detractores from feedback where nps is not null;
