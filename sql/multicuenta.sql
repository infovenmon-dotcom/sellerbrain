-- =====================================================================
-- v16 · MULTICUENTA — base para conectar y almacenar muchas cuentas
-- Ejecuta en Supabase → SQL Editor (incógnito). Seguro re-ejecutar.
--
-- Prepara: (1) almacenamiento SEGURO de las credenciales de cada cliente
-- (refresh_token CIFRADO) y (2) el AISLAMIENTO por cliente (columna `seller`
-- en todas las tablas de datos). El Worker filtra por el `seller` del login.
-- =====================================================================

-- 1) CUENTAS CONECTADAS (tokens cifrados, uno por cliente) -------------
create table if not exists cuentas_spapi (
  seller             text primary key,   -- identificador del cliente (su email por ahora)
  email              text,
  selling_partner_id text,               -- id del vendedor en Amazon
  refresh_token      text,               -- CIFRADO (AES-GCM, prefijo 'enc:')
  marketplaces       text,               -- ES,FR,IT… (se rellena tras conectar)
  estado             text default 'activa',
  creado             timestamptz default now()
);
alter table cuentas_spapi enable row level security;

-- La de Ads puede existir ya (del OAuth de publicidad); añadimos columnas nuevas.
create table if not exists cuentas_ads (
  email         text primary key,
  refresh_token text,
  creado        timestamptz default now()
);
alter table cuentas_ads add column if not exists seller text;
alter table cuentas_ads add column if not exists estado text default 'activa';
alter table cuentas_ads enable row level security;

-- 2) AISLAMIENTO POR CLIENTE — columna `seller` en las tablas de datos ---
--    Los datos actuales (VENMON) quedan como 'venmon'. Cada cliente nuevo
--    llevará SU seller. El Worker filtrará por el seller del JWT.
do $$
declare t text;
begin
  foreach t in array array[
    'pedidos_dia','ventas_sku_pais_dia','settlement_lineas','settlements',
    'devoluciones','inventario','productos_catalogo','costes_producto',
    'ppc_dia','ppc_campanas','ppc_terminos','ppc_producto','ppc_hora_snap',
    'ppc_pendientes','busquedas_marca','ingestas'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name=t) then
      execute format('alter table %I add column if not exists seller text default ''venmon''', t);
      execute format('create index if not exists %I on %I (seller)', 'idx_'||t||'_seller', t);
    end if;
  end loop;
end $$;

-- Comprobar:
-- select seller, count(*) from pedidos_dia group by seller;
-- select seller, email, selling_partner_id, estado from cuentas_spapi;
