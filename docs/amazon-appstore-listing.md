# SellerBrain — Ficha para el Selling Partner Appstore

> Borrador listo para pegar en el formulario de listado de la app.
> Requisito obligatorio del tier PUBLIC (caso 21367423751). Ajusta lo que veas.

---

## 1. Datos básicos de la app

| Campo | Valor |
|---|---|
| **Nombre de la app** | SellerBrain |
| **Proveedor** | VENMON NATURALMENTE SL |
| **Web** | https://sellersbrain.io |
| **Email de soporte** | (poner un buzón de soporte, p. ej. soporte@sellersbrain.io) |
| **Categoría principal** | Analytics & Reporting (Analítica e informes) |
| **Categoría secundaria** | Advertising Optimization / Inventory Management |
| **Regiones / Marketplaces** | Europa: ES, FR, IT, DE, NL, SE, PL, BE, UK |
| **Modelo de precios** | Suscripción (SaaS). Prueba disponible. |

---

## 2. Descripción corta (tagline, ~1 frase)

> SellerBrain convierte tus datos de Amazon en acciones con su valor en euros: beneficio real por producto, tarifas mal cobradas, reembolsos pendientes y publicidad optimizada.

## 3. Descripción larga

SellerBrain es una herramienta de analítica para vendedores de Amazon FBA que no se queda en enseñar datos: **cada dato se convierte en una acción concreta con su impacto en euros**.

Cada vendedor autoriza SellerBrain sobre su propia cuenta y, de forma automática cada noche, la aplicación descarga sus informes oficiales de Amazon para calcular:

- **Beneficio neto real por producto**, con las tarifas FBA e IVA reales cobrados por unidad (no estimaciones).
- **Tarifas mal cobradas y reembolsos pendientes** que Amazon debe al vendedor, detectados de forma automática.
- **Tasa de devolución por SKU** y costes logísticos reales.
- **Control de stock y días de cobertura**, con previsión de temporada (picos como Black Friday o Navidad).
- **Optimización de publicidad**: ACoS frente al punto de equilibrio, términos de búsqueda que conviene negativizar o pujar, y gasto real por producto.

Todo con los datos propios de cada vendedor, de forma segura y sin tocar información personal de compradores.

## 4. Funcionalidades destacadas (bullets del listado)

- Beneficio neto real por producto con tarifas FBA e IVA reales.
- Detección automática de sobrecostes de tarifas y reembolsos pendientes.
- Panel de rentabilidad por producto, país y periodo (P&L).
- Optimización de publicidad (Amazon Ads): ACoS vs break-even, términos y pujas.
- Control de stock, cobertura y previsión de temporada.
- Generador y auditoría de listings optimizados.

---

## 5. Roles SP-API solicitados y para qué se usan
(Para la sección de justificación de datos; coincide con lo aprobado.)

| Rol | Uso |
|---|---|
| Inventory and Order Management | Ventas y unidades por SKU/día; control de inventario y cobertura. |
| Finance & Accounting | Settlements: tarifas reales por unidad y beneficio neto real. |
| Amazon Fulfillment / Amazon Logistics | Devoluciones, tarifas logísticas e inventario FBA. |
| Pricing | Precios propios del vendedor para análisis de márgenes. |
| Brand Analytics | Términos de búsqueda para optimizar keywords y publicidad. |
| Product Listing | Lectura/mejora de la ficha del propio vendedor. |

---

## 6. Tratamiento de datos (resumen para la ficha)

- Datos alojados en la **UE** (Supabase/PostgreSQL) con **Row Level Security**: cada vendedor accede solo a sus datos.
- Tokens de autorización **cifrados** (AES-GCM).
- **No** se solicita, procesa ni almacena información personal de compradores (PII).
- Subencargados de infraestructura: **Cloudflare** (cómputo) y **Supabase** (base de datos UE). No se comparte con ningún otro tercero.
- Datos obtenidos **exclusivamente** de las API oficiales de Amazon (SP-API y Ads API).

---

## 7. Recursos que Amazon pedirá (checklist)

- [ ] **Logo** de la app (formato/medidas que indique el formulario).
- [ ] **Capturas** del producto (dashboard, P&L, PPC, stock) — sin datos sensibles de terceros.
- [ ] **Email de soporte** operativo.
- [ ] **URL de la política de privacidad** (ver documento aparte).
- [ ] **URL de la web** cumpliendo las Website Guidelines (ver checklist aparte).
