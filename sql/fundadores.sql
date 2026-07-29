-- =====================================================================
-- FUNDADORES — ciclo de vida con fechas + correos automáticos de seguimiento.
-- Ejecuta en Supabase → SQL Editor. Idempotente.
--
-- Modelo:
--   · Acceso fundador = 2 meses por 25 €.  inicio = pago,  fin = inicio + 60 días.
--   · E-15 días: correo de seguimiento (preguntas).
--   · E (mismo día): correo de renovación con enlaces (20 €/mes o 200 €/año).
--   · E+7 días: último aviso + BAJA (se corta el acceso).
--   · Si no renueva → borrado de datos tras el margen de gracia (E+21 por defecto,
--     y solo si BORRADO_AUTO=1 en Cloudflare).
--   · Si renueva (paga suscripción) → estado 'renovado', se paran los correos.
--
-- El barrido lo hace el cron del Worker una vez al día (procesarFundadores).
-- =====================================================================

-- Columnas de ciclo de vida en la tabla de miembros (ya existe).
alter table miembros add column if not exists inicio  date;          -- inicio del acceso fundador
alter table miembros add column if not exists fin     date;          -- fin del acceso (inicio + 60 días)
alter table miembros add column if not exists estado  text default 'activo';  -- activo | baja | renovado
alter table miembros add column if not exists aviso1  timestamptz;   -- seguimiento (E-15) enviado
alter table miembros add column if not exists aviso2  timestamptz;   -- renovación (E) enviado
alter table miembros add column if not exists aviso3  timestamptz;   -- último aviso (E+7) enviado
alter table miembros add column if not exists borrado timestamptz;   -- fecha de borrado de datos
create index if not exists idx_miembros_estado_fin on miembros (estado, fin);

-- plan pasa a describir el ciclo: 'fundador' | 'mensual' | 'anual' | 'beta'
-- (no hace falta cambiar nada; es texto libre).

-- Registro de correos enviados (auditoría; el Worker también usa los flags de arriba).
create table if not exists fundador_avisos (
  id     bigint generated always as identity primary key,
  email  text not null,
  tipo   text not null,             -- seguimiento | renovacion | ultimo_aviso
  fin    date,
  creado timestamptz default now()
);
alter table fundador_avisos enable row level security;

-- Auditoría de bajas/borrados (para saber qué se borró y cuándo).
create table if not exists fundador_bajas (
  seller  text,
  email   text,
  motivo  text,                     -- 'no_renovado'
  tablas  text,                     -- qué se borró (resumen)
  creado  timestamptz default now()
);
alter table fundador_bajas enable row level security;

-- Comprobar:
-- select email, plan, estado, inicio, fin, aviso1, aviso2, aviso3, borrado
--   from miembros order by fin nulls last;
-- select * from fundador_avisos order by creado desc;
-- select * from fundador_bajas order by creado desc;
