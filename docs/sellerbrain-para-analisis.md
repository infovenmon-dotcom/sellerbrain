# SellerBrain — Documento para análisis externo (IA)

> Este documento describe **qué es SellerBrain y cómo funciona**, para que una IA
> (Claude u otra) pueda analizar el trabajo, la funcionalidad y proponer mejoras
> **sin necesidad de entrar a la herramienta**. No contiene claves, tokens ni
> datos de clientes. Los datos reales viven detrás de un login y no se exponen.

---

## 1. Qué es y a quién sirve

**SellerBrain** es una herramienta de analítica y decisión para **vendedores de
Amazon FBA**. La diferencia frente a la competencia:

- **Sellerboard** te muestra datos.
- **Helium 10** te da keywords.
- **SellerBrain convierte cada dato en una acción con su valor en euros**:
  *"negativiza este término de búsqueda: +18 €/mes"*, *"reclama esta tarifa mal
  cobrada: +31 €/mes"*, *"este producto pierde dinero en publicidad, baja la puja"*.

Lo construye un vendedor FBA en activo (dos marcas propias con Brand Registry,
~53 SKUs vendiendo en España, Francia, Italia y Bélgica). **Cada función se valida
contra una cuenta real de Amazon antes de darla por buena.**

---

## 2. Cómo funciona por dentro (arquitectura, alto nivel)

```
Navegador (web estática: landing + dashboard + portal de calculadoras)
        │  el panel pide datos a una API propia
        ▼
API backend (sin servidor, en el edge)
        │  ingesta automática una vez al día + captura horaria de publicidad
        ├── Amazon Ads API  → gasto y rendimiento de publicidad (PPC)
        └── Amazon SP-API   → ventas, pedidos, tarifas, devoluciones, stock
        ▼
Base de datos PostgreSQL (europea, con seguridad por filas)
        │  vistas que agregan ventas, márgenes, tarifas y P&L
        ▼
El panel las pinta: tarjetas, gráficos, tabla de productos y cuenta de resultados
```

Puntos clave del diseño:
- **Web estática + API sin servidor**: rápido, barato y sin infraestructura que mantener.
- **Tokens de cada vendedor cifrados** en la base de datos (nunca en el navegador).
- **Multi-idioma de mercado**: entiende que el IVA y las tarifas cambian por país
  (ES 21 %, FR 20 %, IT 22 %, DE 19 %…) y lo aplica producto a producto.

---

## 3. Funcionalidades (lo que hace hoy)

### 3.1 Panel principal (dashboard)
- **Tarjetas** de ventas por periodo: hoy, ayer, este mes, mes pasado, este año,
  año pasado — cada una con unidades, pedidos, gasto de publicidad, beneficio y margen %.
- **Selector de fechas** que controla a la vez el gráfico, la comparativa y la
  cuenta de resultados (P&L) de debajo.
- **Gráfico "Beneficio vs Ventas"** interactivo, con el dato de cada día al pasar el ratón.
- **Dos comparativas**:
  - Este mes **vs el mismo mes del año pasado**, día a día, con un % de cómo va el mes.
  - **Gráfico mensual estilo Seller Central**: barras por mes, con selector de país
    y conmutador €Ventas / Unidades.

### 3.2 Márgenes reales (el corazón del producto)
El reto: en Amazon las **tarifas se liquidan con desfase** (las de junio aparecen en
julio), y los informes mezclan importes **con y sin IVA**. SellerBrain lo resuelve:
- La **venta se muestra CON IVA** (igual que en Seller Central, para que cuadre).
- El **IVA repercutido se resta como una línea** (va a Hacienda, no es beneficio).
- Las **tarifas se aplican por unidad real** (€/ud), no por fecha de liquidación,
  así el margen del mes en curso es correcto aunque Amazon aún no haya liquidado todo.
- El **coste de producto** se toma sin IVA (IVA recuperable).
- Resultado: **margen por producto real**, con **semáforo** verde/ámbar/rojo.

### 3.3 Publicidad (PPC)
- Ingesta fiable del gasto y rendimiento por día, país y campaña (con reintentos y
  recuperación si Amazon falla).
- Métricas explicadas al usuario: **ACoS, ROAS, TACoS**.
- **Break-even ACoS por producto**: el % máximo que puedes gastar en publicidad de
  una venta sin perder dinero, con veredicto (rentable / ajustado / en pérdida).
- **PPC por horas (dayparting)**: captura horaria para, con ~una semana de datos,
  proponer un plan de pujas por franja horaria.

### 3.4 Otros módulos
- **Satisfacción del cliente**: como Amazon no tiene API de reseñas, se refleja a
  través de los **motivos de devolución** por producto (plegable, con enlace directo
  a la ficha del producto en Seller Central).
- **Stock**: días de cobertura por SKU y aviso de "pide ya".
- **Cuenta de resultados (P&L)** del periodo: ventas, IVA repercutido, coste,
  tarifas FBA, comisión Amazon, PPC, devoluciones, almacenaje y ajustes → beneficio neto.
- **Calculadoras de tarifas FBA** (Europa y USA 2026, auditadas contra el Excel oficial
  de Amazon: tramos de peso, gran tamaño, peso dimensional…).
- **Módulo EPR de envases** (obligación normativa europea).

---

## 4. Estado actual

| Pieza | Estado |
|---|---|
| Backend (API + base de datos) | Desplegado y en marcha |
| Amazon Ads API (publicidad) | Conectada, datos reales entrando |
| Amazon SP-API (ventas/tarifas) | Conectada para la cuenta propia; ampliación a más cuentas en preparación |
| Panel + márgenes reales + P&L | Construido y en afinado final |
| Calculadoras de tarifas | En producción |
| Multi-cuenta (abrir a +50 betas) | Infraestructura preparada, despliegue por fases |

---

## 5. Modelo de negocio (resumen)
- **Founders Beta**: pago único simbólico, 3 meses, plazas limitadas, sin renovación automática.
- **Continuación fundador**: precio bajo **bloqueado para siempre** por ser de los primeros.
- **Cohortes futuras**: el precio base sube según crece la base de usuarios; los
  fundadores no se ven afectados (grandfathering).

---

## 6. En qué nos vendría bien tu análisis (para la IA)
Si estás analizando esto, nos interesan sobre todo estas perspectivas:
1. **Propuesta de valor**: ¿el ángulo "cada dato = una acción en euros" está bien
   diferenciado frente a Sellerboard/Helium 10? ¿Cómo reforzarlo?
2. **Funcionalidad que falta** para un vendedor FBA serio (¿qué echarías en falta?).
3. **Riesgos del modelo de márgenes** (IVA, desfase de tarifas, multi-país): ¿ves
   algún supuesto que pueda dar un número engañoso?
4. **Prioridad de roadmap**: con recursos limitados, ¿qué construirías primero?
5. **Precios y posicionamiento**: ¿el modelo Founders + grandfathering es sólido?

---

*Nota: la herramienta en vivo está detrás de login, así que analizar la URL solo
mostraría la web pública. Este documento es la forma completa de evaluar el trabajo.
Para ver el producto funcionando con datos, lo mejor es una demo guiada o capturas.*
