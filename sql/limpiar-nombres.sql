-- =====================================================================
-- Limpieza de nombres con acentos rotos (mojibake)
-- Ejecuta en Supabase -> SQL Editor (incognito). COPIA/PEGA el archivo entero
-- (asi se conservan bien los caracteres). REPLACE NO da el error de codificacion
-- que sale con el truco LATIN1. Solo cambia lo que coincide. Idempotente.
--
--   A cada linea: [secuencia rota] -> [caracter correcto].
-- =====================================================================

-- Minusculas acentuadas + enye + u-dieresis
update productos_catalogo set nombre = replace(nombre, E'Ã¡', E'á') where nombre like E'%Ã¡%'; -- a acento
update productos_catalogo set nombre = replace(nombre, E'Ã©', E'é') where nombre like E'%Ã©%'; -- e acento
update productos_catalogo set nombre = replace(nombre, E'Ã­', E'í') where nombre like E'%Ã­%'; -- i acento
update productos_catalogo set nombre = replace(nombre, E'Ã³', E'ó') where nombre like E'%Ã³%'; -- o acento
update productos_catalogo set nombre = replace(nombre, E'Ãº', E'ú') where nombre like E'%Ãº%'; -- u acento
update productos_catalogo set nombre = replace(nombre, E'Ã±', E'ñ') where nombre like E'%Ã±%'; -- enye
update productos_catalogo set nombre = replace(nombre, E'Ã¼', E'ü') where nombre like E'%Ã¼%'; -- u dieresis

-- Mayusculas acentuadas (mas raras)
update productos_catalogo set nombre = replace(nombre, E'Ã‰', E'É') where nombre like E'%Ã‰%'; -- E acento
update productos_catalogo set nombre = replace(nombre, E'Ã“', E'Ó') where nombre like E'%Ã“%'; -- O acento
update productos_catalogo set nombre = replace(nombre, E'Ã‘', E'Ñ') where nombre like E'%Ã‘%'; -- Enye may
update productos_catalogo set nombre = replace(nombre, E'Ãš', E'Ú') where nombre like E'%Ãš%'; -- U acento

-- Simbolos: masculino, femenino, punto medio, espacio duro
update productos_catalogo set nombre = replace(nombre, E'Âº', E'º') where nombre like E'%Âº%';
update productos_catalogo set nombre = replace(nombre, E'Âª', E'ª') where nombre like E'%Âª%';
update productos_catalogo set nombre = replace(nombre, E'Â·', E'·') where nombre like E'%Â·%';
update productos_catalogo set nombre = replace(nombre, E'Â ', ' ')       where nombre like E'%Â %';

-- Guion largo y comillas tipograficas (3 bytes)
update productos_catalogo set nombre = replace(nombre, E'â€“', E'–') where nombre like E'%â€“%'; -- guion largo
update productos_catalogo set nombre = replace(nombre, E'â€™', E'’') where nombre like E'%â€™%'; -- comilla simple
update productos_catalogo set nombre = replace(nombre, E'â€¦', E'…') where nombre like E'%â€¦%'; -- puntos suspensivos

-- Comprobar que ya no quedan rotas (idealmente 0)
select count(*) as filas_rotas_restantes
from productos_catalogo
where nombre like E'%Ã%' or nombre like E'%Â%' or nombre like E'%â€%';
