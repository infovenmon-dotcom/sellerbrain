-- =====================================================================
-- PPC DIARIO · términos y rentabilidad por producto → granularidad por DÍA.
-- Ejecuta en Supabase → SQL Editor ANTES de pegar el Worker v65. Idempotente.
--
-- Por qué: hasta ahora `ppc_terminos` y `ppc_producto` se guardaban como UN
-- resumen del periodo (una fila por término/SKU y ventana). Eso impedía filtrar
-- esos bloques por día/rango desde el gráfico. Con una columna `fecha` y la clave
-- ampliada, cada día convive como su propia fila y el dashboard puede trocearlos.
--
-- SIN PÉRDIDA: no borra nada. A las filas actuales les pone fecha = su `hasta`
-- (quedan visibles). La próxima sincronización (informe DAILY) añade el detalle
-- día a día y reemplaza esas filas donde coincida término/SKU + día.
-- =====================================================================

do $$
declare
  t text; conname text; pkcols text;
begin
  foreach t in array array['ppc_terminos','ppc_producto'] loop
    if not exists (select 1 from information_schema.tables
                   where table_schema='public' and table_name=t) then
      raise notice 'SALTO: % no existe todavía', t; continue;
    end if;

    -- 1) columna fecha + relleno desde `hasta` (sin borrar) + NOT NULL
    execute format('alter table %I add column if not exists fecha date', t);
    execute format('update %I set fecha = coalesce(fecha, hasta, current_date) where fecha is null', t);
    execute format('alter table %I alter column fecha set not null', t);

    -- 2) clave primaria actual
    select con.conname,
           string_agg(att.attname, ',' order by array_position(con.conkey, att.attnum))
      into conname, pkcols
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
    where con.conrelid = format('public.%I', t)::regclass and con.contype = 'p'
    group by con.conname;

    if conname is null then
      raise notice 'AVISO: % no tiene PK -> se deja sin tocar (el upsert seguirá por defecto)', t;
      continue;
    end if;
    if position('fecha' in pkcols) > 0 then
      raise notice 'OK: % ya tiene fecha en la PK (%).', t, pkcols; continue;
    end if;

    -- 3) recolocar la PK añadiendo `fecha` (así un término/SKU puede repetirse por día)
    execute format('alter table %I drop constraint %I', t, conname);
    execute format('alter table %I add primary key (%s,fecha)', t, pkcols);
    raise notice 'HECHO: PK de % -> (%,fecha).', t, pkcols;
  end loop;
end $$;

-- Comprobar:
-- select 'ppc_terminos' tabla, count(*) filas, count(fecha) con_fecha from ppc_terminos
-- union all
-- select 'ppc_producto', count(*), count(fecha) from ppc_producto;
--
-- PK resultantes:
-- select tc.table_name,
--        string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as pk
-- from information_schema.table_constraints tc
-- join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
-- where tc.constraint_type='PRIMARY KEY' and tc.table_schema='public'
--   and tc.table_name in ('ppc_terminos','ppc_producto')
-- group by tc.table_name;
