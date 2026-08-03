-- =====================================================================
-- Preferencias de ALERTAS por email, por vendedor. El opt-in y los umbrales
-- se guardan aquí (mandan sobre los valores por defecto del worker). La clave
-- es 'seller' (en SellerBrain = el email de registro del vendedor).
-- Ejecuta en Supabase -> SQL Editor.
-- =====================================================================

create table if not exists alertas_prefs (
  seller       text primary key,
  email        text,
  activo       boolean not null default true,   -- opt-in: recibir alertas o no
  stock_dias   int,                             -- avisar si cobertura <= N días (null = por defecto del worker)
  acos         numeric,                         -- avisar si ACoS 7d > N% (null = por defecto)
  sobrecoste   numeric,                         -- avisar si recuperable >= N €/mes (null = por defecto)
  actualizado  timestamptz not null default now()
);

-- RLS: la tabla solo la toca el Worker con la service key (que la bypassa).
-- Actívala para que nadie más pueda leerla con la anon key.
alter table alertas_prefs enable row level security;

-- Comprobar:
-- select * from alertas_prefs;
