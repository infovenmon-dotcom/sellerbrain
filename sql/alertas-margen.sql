-- =====================================================================
-- ALERTAS · umbral de RENTABILIDAD. Añade a alertas_prefs el margen mínimo (%)
-- por debajo del cual un producto dispara aviso (por defecto 10%). Preventivo:
-- avisa ANTES de entrar en pérdidas, para bajar pujas o pausar la campaña.
-- Ejecuta en Supabase. Idempotente.
-- =====================================================================

alter table alertas_prefs add column if not exists margen_min numeric default 10;

-- Comprobar:
-- select seller, activo, acos, sobrecoste, margen_min from alertas_prefs;
