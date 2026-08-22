-- =====================================================================
-- COMPROBACIÓN DE ETIQUETADO POR CLIENTE (antes de activar el aislamiento).
-- Ejecuta en Supabase → SQL Editor. Solo LEE.
--
-- Antes de filtrar las lecturas por `seller`, hay que asegurarse de que TODOS
-- los datos actuales de VENMON están etiquetados con seller='venmon'. Si alguna
-- fila tiene seller NULL o vacío, al activar el filtro esos datos "desaparecerían"
-- del panel. Esta consulta cuenta las filas por seller en las tablas clave.
-- =====================================================================

select 'ventas_sku_pais_dia' as tabla, coalesce(seller,'(null)') as seller, count(*) filas from ventas_sku_pais_dia group by 2
union all select 'pedidos_dia',        coalesce(seller,'(null)'), count(*) from pedidos_dia group by 2
union all select 'settlement_lineas',  coalesce(seller,'(null)'), count(*) from settlement_lineas group by 2
union all select 'inventario',         coalesce(seller,'(null)'), count(*) from inventario group by 2
union all select 'inventario_pais',    coalesce(seller,'(null)'), count(*) from inventario_pais group by 2
union all select 'devoluciones',       coalesce(seller,'(null)'), count(*) from devoluciones group by 2
union all select 'reembolsos',         coalesce(seller,'(null)'), count(*) from reembolsos group by 2
union all select 'ppc_dia',            coalesce(seller,'(null)'), count(*) from ppc_dia group by 2
union all select 'ppc_terminos',       coalesce(seller,'(null)'), count(*) from ppc_terminos group by 2
union all select 'productos_catalogo', coalesce(seller,'(null)'), count(*) from productos_catalogo group by 2
union all select 'costes_producto',    coalesce(seller,'(null)'), count(*) from costes_producto group by 2
order by 1, 2;

-- Cómo leerlo:
-- · Si TODO sale con seller='venmon' → perfecto, podemos activar el filtro sin perder nada.
-- · Si aparece '(null)' o vacío en alguna tabla → primero hay que etiquetar esas filas
--   (UPDATE ... set seller='venmon' where seller is null) ANTES de activar el filtro.
--
-- Etiquetado (SOLO si arriba salen filas '(null)'; ejecútalo tabla por tabla según haga falta):
-- update ventas_sku_pais_dia set seller='venmon' where seller is null;
-- update pedidos_dia          set seller='venmon' where seller is null;
-- ...(una por cada tabla que lo necesite)
