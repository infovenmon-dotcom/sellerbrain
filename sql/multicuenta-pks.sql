-- =====================================================================
-- MULTICUENTA · paso 2 — meter `seller` en la CLAVE PRIMARIA de las tablas de
-- datos naturales. Necesario ANTES de conectar un segundo vendedor: si no,
-- dos vendedores con el mismo SKU/fecha se pisarían en el upsert.
--
-- Idempotente y seguro:
--  · Solo toca tablas con clave "natural" (sku/fecha/pais…). Las de clave única
--    propia (settlements, settlement_lineas, reembolsos, ppc_pendientes) NO se
--    tocan: su id ya es único por cuenta y tienen columna `seller` para filtrar.
--  · Rellena seller='venmon' en lo existente y lo deja NOT NULL.
--  · Si una tabla ya tiene seller en la PK, la salta.
-- Ejecútalo en Supabase → SQL Editor (mira los NOTICE al final).
-- =====================================================================

do $$
declare
  t text;
  conname text;
  pkcols text;
begin
  foreach t in array array[
    'pedidos_dia','ventas_sku_pais_dia','productos_catalogo','costes_producto',
    'inventario','inventario_pais','inventario_ajustes','devoluciones',
    'ppc_dia','ppc_campanas','ppc_terminos','ppc_producto',
    'ppc_hora_snap','ppc_hora_camp_snap','ppc_presupuestos'
  ] loop
    if not exists (select 1 from information_schema.tables
                   where table_schema='public' and table_name=t) then
      continue;
    end if;

    -- 1) columna seller garantizada + NOT NULL
    execute format('alter table %I add column if not exists seller text default ''venmon''', t);
    execute format('update %I set seller=''venmon'' where seller is null', t);
    execute format('alter table %I alter column seller set not null', t);

    -- 2) clave primaria actual
    select con.conname,
           string_agg(att.attname, ',' order by array_position(con.conkey, att.attnum))
      into conname, pkcols
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
    where con.conrelid = format('public.%I', t)::regclass and con.contype = 'p'
    group by con.conname;

    if conname is null then
      raise notice 'AVISO: % no tiene PK -> se omite (se filtrará por la columna seller)', t;
      continue;
    end if;
    if position('seller,' in pkcols||',') > 0 then
      raise notice 'OK: % ya tiene seller en la PK (%).', t, pkcols;
      continue;
    end if;

    -- 3) recolocar la PK con seller delante
    execute format('alter table %I drop constraint %I', t, conname);
    execute format('alter table %I add primary key (seller,%s)', t, pkcols);
    raise notice 'HECHO: PK de % -> (seller,%).', t, pkcols;
  end loop;
end $$;

-- Comprobar las PK resultantes:
-- select tc.table_name,
--        string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as pk
-- from information_schema.table_constraints tc
-- join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
-- where tc.constraint_type='PRIMARY KEY' and tc.table_schema='public'
-- group by tc.table_name order by tc.table_name;
