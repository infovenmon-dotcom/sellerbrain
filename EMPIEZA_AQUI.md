# EMPIEZA_AQUI — Migración a Claude Code

> Léelo tú primero (humano). Luego abre Claude Code en la carpeta del repo y dile:
> *"Lee EMPIEZA_AQUI.md, CONTEXTO.md y TAREAS.md y dime por dónde empezamos."*

---

## 1. Qué es Claude Code y por qué lo usamos

Claude Code es Claude trabajando **directamente sobre los archivos de tu repositorio**:
edita el código, hace los commits y tú los subes. Se acabó el copiar-pegar archivos por chat.
Para un proyecto que ya vive en GitHub y que vas a iterar rápido, es el entorno natural.

**Lo que Claude Code hace por ti:** editar HTML/JS del repo, crear archivos, arreglar bugs,
hacer commits ordenados, leer todo el proyecto a la vez.

**Lo que sigues haciendo tú** (son paneles web, no código): secretos en Cloudflare,
migraciones en Supabase, pantallas de Amazon, configurar Netlify. Claude Code te guía, pero
esos botones los pulsas tú.

---

## 2. Instalación (una vez)

Necesitas **Node.js** instalado (versión 18 o superior). Compruébalo abriendo una terminal:
```
node --version
```
Si no lo tienes, descárgalo de nodejs.org (versión LTS) e instálalo.

Luego instala Claude Code:
```
npm install -g @anthropic-ai/claude-code
```

Para arrancarlo, entra en la carpeta de tu repo y ejecuta:
```
cd ruta/a/tu/repo-sellerbrain
claude
```
La primera vez te pedirá iniciar sesión con tu cuenta de Anthropic (la misma de este chat).

> Si algún comando o detalle de instalación no coincide, busca "Claude Code install" en
> docs.claude.com — puede haber cambiado desde que se escribió esto.

---

## 3. Permisos que tienes que dar (y los que NO)

### GitHub — el repositorio
- **Ponlo en PRIVADO** si no lo está: repo en github.com → **Settings** → **General** →
  abajo del todo, **Danger Zone** → **Change repository visibility** → **Private**.
  Motivo: contiene tu código de producto y hubo una clave expuesta. Netlify funciona igual
  con repos privados.
- **Claude Code no necesita permisos especiales en GitHub.** Trabaja sobre los archivos que
  tienes descargados en tu ordenador (el "clon" local del repo). Tú haces `git push` para subir.
- Si usas la web de GitHub o GitHub Desktop para subir, tampoco hay que dar permisos a Claude.

### Qué NO subir nunca al repo (ya está en .gitignore)
- `config.js` — tiene credenciales. Solo la plantilla `config.example.js` se sube.
- Cualquier archivo con claves, tokens o secretos.

### Claude Code — permisos en tu ordenador
- La primera vez que Claude Code quiera **editar un archivo** o **ejecutar un comando**, te
  pide confirmación. Puedes aprobar cada acción, o darle permiso para toda la sesión.
- Recomendación al principio: **aprueba acción por acción** hasta que cojas confianza. Así ves
  exactamente qué toca.
- **No le des acceso a carpetas fuera del proyecto.** Trabaja solo dentro de la carpeta del repo.

### Lo que Claude Code NO debe tocar
- Los **secretos de Cloudflare, Supabase y Amazon** no están en el repo (bien hecho) — Claude
  Code no los ve ni los necesita. Si una tarea requiere cambiarlos, te dirá que lo hagas tú
  en el panel correspondiente.

---

## 4. Estructura del repo (cómo debe quedar)

```
repo-sellerbrain/
├── index.html          hub del entorno de pruebas
├── landing.html        portada nueva
├── dashboard.html      panel + vista PPC (apunta al Worker real)
├── portal.html         herramientas (clave leída de config.js, NO incrustada)
├── epr.html            módulo EPR envases
├── ppc-horas.html      dayparting
├── config.example.js   plantilla de credenciales (SÍ se sube)
├── config.js           credenciales reales (NO se sube — está en .gitignore)
├── .gitignore
├── netlify.toml
├── _headers
├── robots.txt
├── EMPIEZA_AQUI.md     este archivo
├── CONTEXTO.md         mapa completo del proyecto
└── TAREAS.md           lista de trabajo priorizada
```

**Importante sobre `config.js`:** como ya se subió una vez con la clave, esa clave quedó en
el historial de Git. Como es una clave de GoHighLevel (no tuya) y de solo lectura, el riesgo
es bajo, pero: con el repo en privado queda contenido. La solución de fondo (tarea en TAREAS.md)
es el login propio en el Worker, que hace esa clave irrelevante.

---

## 5. Despliegue en Netlify (conectado a GitHub)

Una vez el repo esté ordenado y privado:

1. Netlify → **Add new site** → **Import an existing project** → **GitHub**.
2. Autoriza a Netlify a leer tu repo (esto sí es un permiso: Netlify necesita leer el repo
   para publicarlo — es seguro y estándar).
3. Elige tu repositorio.
4. Build settings: **déjalo vacío** (son HTML planos, no hay build). Publish directory: `.`
5. **Deploy**. A partir de ahí, cada `git push` publica solo en segundos.
6. **Sube `config.js` a Netlify aparte** (no viene del repo): en Netlify puedes subirlo con
   el método de "drag and drop" adicional, o —mejor a futuro— gestionar las credenciales de
   otra forma cuando montemos el login en el Worker. Para las pruebas, lo más simple: súbelo
   manualmente una vez.
7. (Opcional) Site settings → Change site name → `sellerbrain-pruebas` → URL limpia.

**Producción (sellersbrain.io en GHL) no se toca.** Este Netlify es solo el banco de pruebas.

---

## 6. Cómo trabajar día a día con Claude Code

1. Abres terminal en la carpeta del repo → `claude`.
2. Le pides lo que quieras ("arregla X", "añade Y a la vista PPC").
3. Claude edita los archivos y te muestra los cambios.
4. Cuando estés conforme, subes: `git add .` → `git commit -m "descripción"` → `git push`
   (o Claude Code te ayuda con esos comandos).
5. Netlify publica solo. Refrescas la URL de pruebas y lo ves.

Claude Code puede hacer los commits por ti si se lo pides — pero revisa siempre qué sube.

---

## 7. Primer mensaje sugerido para Claude Code

Copia y pega esto al arrancar:

> Soy el fundador de SellerBrain, un SaaS para vendedores de Amazon FBA. Este repo es el
> entorno de pruebas. Lee CONTEXTO.md para entender la arquitectura completa (backend en
> Cloudflare Worker ya desplegado, Supabase, Amazon Ads API conectada) y TAREAS.md para las
> tareas pendientes priorizadas. No reconstruyas lo que ya funciona. Empecemos por la tarea 1.
> Antes de tocar nada, dime tu plan.
