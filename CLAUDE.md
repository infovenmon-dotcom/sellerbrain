# CLAUDE.md — Instrucciones permanentes para Claude Code

> Claude Code lee este archivo automáticamente al arrancar en este repo.
> Define cómo trabajar en el proyecto SellerBrain.

## Contexto
Lee CONTEXTO.md (arquitectura completa) y TAREAS.md (trabajo priorizado) antes de actuar.
Este es el repositorio del ENTORNO DE PRUEBAS. Producción (sellersbrain.io) está en GHL y NO
se toca desde aquí.

## Cómo trabajar

### Autonomía por tipo de tarea
- **Organización, limpieza, documentación, edición de HTML/CSS del frontend de pruebas**:
  actúa con autonomía. Haz los cambios, commitea con mensaje claro, continúa.
- **Cambios en worker.js (backend en producción) o migraciones SQL de Supabase**:
  PARA y muestra el plan al humano ANTES de aplicar. Estos tocan un sistema vivo con datos
  reales de Amazon. Explica qué cambia y espera su OK.
- **Cualquier cosa que borre datos o haga force-push a git**: pide confirmación explícita.

### Lo que NO puedes hacer (dilo al humano para que lo haga él)
- Configurar secretos en Cloudflare (SUPABASE_KEY, tokens de Amazon, SB_API_KEY).
- Ejecutar SQL en Supabase (solo puedes ESCRIBIR el .sql; lo ejecuta el humano).
- Conectar Netlify, tocar GitHub settings, o pantallas de Amazon Seller Central.
Cuando una tarea lo requiera, genera el archivo o los pasos EXACTOS y dile al humano
qué pulsar, dónde, y qué valor poner. Luego espera y continúa.

### Commits
- Mensajes claros en español: "arregla X", "añade Y", "limpia Z".
- Un commit por cambio lógico, no todo junto.
- Nunca subas config.js ni ningún secreto (está en .gitignore — respétalo).

### Verificación
- Tras cada cambio de código, valida sintaxis (node --check para worker.js, revisar los
  <script> de los HTML).
- No des una tarea por terminada sin comprobar que funciona.

## Reglas de producto (de CONTEXTO.md)
- No reconstruir lo que ya funciona. El backend, la Ads API y los motores de tarifas están bien.
- Tema oscuro, naranja brasa→ámbar, verde SOLO para dinero.
- Copy sin promesas infladas: reflejar solo lo que existe.
- Precisión en datos: no inventar cifras de coste/margen sin confirmación del humano.

## Orden de trabajo
Sigue el orden de TAREAS.md salvo que el humano diga otra cosa. Empieza siempre proponiendo
el plan de la tarea actual antes de ejecutarla.
