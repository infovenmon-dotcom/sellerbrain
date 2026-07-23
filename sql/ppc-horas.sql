-- =====================================================================
-- v13 · PPC por HORAS (para detectar patrones por hora del día)
-- Ejecuta en Supabase → SQL Editor (incógnito). Seguro re-ejecutar.
--
-- Cómo funciona: el cron guarda cada hora una "foto" del gasto/ventas ACUMULADO
-- del día (ppc_hora_snap). Restando fotos consecutivas sacamos lo ocurrido en
-- cada franja (v_ppc_hora). Promediando ~2 semanas por hora del día vemos a qué
-- horas convierte mejor el PPC (v_ppc_mejores_horas) → base del plan de pujas.
-- Es aproximado (Amazon reajusta datos intradía) pero estable al promediar.
-- =====================================================================

create table if not exists ppc_hora_snap (
  pais        text not null,
  fecha       text not null,     -- YYYY-MM-DD (UTC)
  hora        int  not null,     -- 0-23 (hora UTC de la captura)
  gasto       numeric default 0, -- acumulado del día hasta esa hora
  clics       int     default 0,
  impresiones int     default 0,
  ventas      numeric default 0,
  pedidos     int     default 0,
  ts          timestamptz default now(),
  primary key (pais, fecha, hora)
);
alter table ppc_hora_snap enable row level security;

-- Delta por franja: lo ocurrido EN esa hora = acumulado(hora) - acumulado(hora previa).
-- greatest(...,0) evita negativos cuando Amazon reajusta un acumulado a la baja.
create or replace view v_ppc_hora as
with s as (
  select pais, fecha, hora, gasto, clics, ventas, pedidos,
    lag(gasto)   over (partition by pais, fecha order by hora) as g0,
    lag(clics)   over (partition by pais, fecha order by hora) as c0,
    lag(ventas)  over (partition by pais, fecha order by hora) as v0,
    lag(pedidos) over (partition by pais, fecha order by hora) as p0
  from ppc_hora_snap
)
select pais, fecha, hora,
  greatest(gasto   - coalesce(g0, 0), 0) as gasto,
  greatest(clics   - coalesce(c0, 0), 0) as clics,
  greatest(ventas  - coalesce(v0, 0), 0) as ventas,
  greatest(pedidos - coalesce(p0, 0), 0) as pedidos
from s;

-- Patrón por hora del día (media de los últimos 14 días) + ACoS por franja.
create or replace view v_ppc_mejores_horas as
select
  pais, hora,
  round(avg(gasto), 2)  as gasto_medio,
  round(avg(ventas), 2) as ventas_medias,
  round(100 * sum(gasto) / nullif(sum(ventas), 0), 1) as acos,
  count(*)              as dias_con_datos
from v_ppc_hora
where fecha >= to_char((now() at time zone 'utc')::date - 14, 'YYYY-MM-DD')
group by pais, hora
order by pais, hora;

-- Comprobar (cuando haya varias horas capturadas):
-- select * from v_ppc_mejores_horas order by pais, hora;
