# Worker — backend de SellerBrain

Backend en Cloudflare Workers. Conecta Amazon Ads API + (futuro) SP-API con Supabase,
y sirve los datos al dashboard.

- **Desplegado en:** https://sellerbrain-api.info-venmon.workers.dev
- **Código:** worker.js (esta carpeta) es la copia versionada.
- **Despliegue:** se hace desde el panel de Cloudflare (pegar worker.js) o con `wrangler deploy`.

## IMPORTANTE para Claude Code
- Este worker está EN PRODUCCIÓN con datos reales de Amazon entrando.
- Antes de cambiar worker.js: muestra el plan al humano y espera OK (ver CLAUDE.md).
- Los secretos NO están aquí: se configuran en Cloudflare. Nunca incrustes valores.
- Tras editar: valida con `node --check worker.js`. El humano lo despliega (o revisa antes).

## Endpoints principales
Ver CONTEXTO.md en la raíz del repo para la lista completa.
