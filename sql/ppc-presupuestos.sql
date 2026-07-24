-- =====================================================================
-- PRESUPUESTOS de campañas + detección de "limitada por presupuesto".
-- Ejecuta en Supabase -> SQL Editor. Idempotente.
--
-- El Worker trae el presupuesto diario de cada campaña (API de campañas de Ads)
-- y lo guarda aquí. Cruzándolo con el gasto por hora (ppc_hora_camp_snap) sabemos
-- qué campañas AGOTAN su presupuesto y A QUÉ HORA dejan de anunciarse → acción:
-- "sube el budget o baja pujas de día para llegar a la tarde/noche".
-- =====================================================================

create table if not exists ppc_presupuestos (
  pais        text not null,
  campania_id text not null,
  campania    text,
  presupuesto numeric default 0,   -- presupuesto DIARIO
  estado      text,                -- ENABLED / PAUSED / ARCHIVED
  actualizado timestamptz default now(),
  primary key (pais, campania_id)
);
alter table ppc_presupuestos enable row level security;

-- Campañas que HOY ya han gastado >=90% de su presupuesto (limitadas), con la
-- hora (UTC) en la que alcanzan su tope = cuando se quedan sin presupuesto.
create or replace view v_ppc_limitadas as
with hoy as (select to_char((now() at time zone 'utc')::date,'YYYY-MM-DD') as d),
gastos as (
  select s.pais, s.campania_id, max(s.campania) as campania, max(s.gasto) as total_dia
  from ppc_hora_camp_snap s, hoy
  where s.fecha = hoy.d
  group by s.pais, s.campania_id
),
hora_tope as (
  select s.pais, s.campania_id, min(s.hora) as hora_tope
  from ppc_hora_camp_snap s, hoy, gastos g
  where s.fecha = hoy.d and s.pais = g.pais and s.campania_id = g.campania_id
    and g.total_dia > 0 and s.gasto >= g.total_dia
  group by s.pais, s.campania_id
)
select
  g.pais, g.campania_id, g.campania,
  round(g.total_dia, 2)                              as total_dia,
  round(p.presupuesto, 2)                            as presupuesto,
  p.estado,
  ht.hora_tope,
  round(100.0 * g.total_dia / nullif(p.presupuesto,0), 0) as pct_budget
from gastos g
join ppc_presupuestos p on p.pais = g.pais and p.campania_id = g.campania_id
left join hora_tope ht on ht.pais = g.pais and ht.campania_id = g.campania_id
where p.presupuesto > 0
  and g.total_dia >= p.presupuesto * 0.9
order by g.total_dia desc;

-- Comprobar:
-- select * from ppc_presupuestos order by presupuesto desc;
-- select * from v_ppc_limitadas;
