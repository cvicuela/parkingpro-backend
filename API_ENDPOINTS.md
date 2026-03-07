# ParkingPro API — Endpoints Reference

Base URL: `/api/v1`

## Autenticación
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| POST | `/auth/register` | Registrar usuario | Público |
| POST | `/auth/login` | Iniciar sesión | Público |
| GET | `/auth/me` | Perfil del usuario actual | Auth |

## Clientes
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/customers` | Listar clientes | operator, admin |
| GET | `/customers/:id` | Obtener cliente | operator, admin |
| POST | `/customers` | Crear cliente | operator, admin |
| PATCH | `/customers/:id` | Actualizar cliente | operator, admin |
| DELETE | `/customers/:id` | Eliminar cliente | admin |

## Vehículos
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/vehicles` | Listar vehículos | operator, admin |
| GET | `/vehicles/:id` | Obtener vehículo | operator, admin |
| GET | `/vehicles/plate/:plate` | Buscar por placa | operator, admin |
| POST | `/vehicles` | Crear vehículo | operator, admin |
| PATCH | `/vehicles/:id` | Actualizar vehículo | operator, admin |

## Planes
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/plans` | Listar planes | operator, admin |
| POST | `/plans` | Crear plan | admin |
| GET | `/plans/:id/occupancy` | Ocupación del plan | operator, admin |
| GET | `/plans/hourly/rates/:planId` | Tarifas por hora | operator, admin |
| POST | `/plans/hourly/calculate` | Calcular tarifa | operator, admin |

## Suscripciones
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/subscriptions` | Listar | operator, admin |
| POST | `/subscriptions` | Crear | operator, admin |
| POST | `/subscriptions/:id/suspend` | Suspender | admin |
| POST | `/subscriptions/:id/reactivate` | Reactivar | admin |
| GET | `/subscriptions/:id/qr` | Generar QR | operator, admin |

## Control de Acceso
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| POST | `/access/validate` | Validar acceso QR/placa | operator, admin |
| POST | `/access/entry` | Registrar entrada | operator, admin |
| POST | `/access/exit` | Registrar salida | operator, admin |
| GET | `/access/sessions/active` | Sesiones activas | operator, admin |
| POST | `/access/sessions/:id/payment` | Cobrar sesión (registra en caja) | operator, admin |

## Pagos
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/payments` | Listar (filtros: status, startDate, endDate, search) | operator, admin |
| GET | `/payments/:id` | Detalle con NCF vinculado | operator, admin |
| POST | `/payments/:id/refund` | Reembolsar (límite RD$500 operadores) | operator, admin |

## Caja Registradora
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| POST | `/cash-registers/open` | Abrir caja con fondo inicial | operator, admin |
| GET | `/cash-registers/active` | Caja activa del operador | operator, admin |
| GET | `/cash-registers/limits` | Obtener umbrales configurados | Auth |
| POST | `/cash-registers/:id/close` | Cerrar caja (conteo por denominación) | operator, admin |
| POST | `/cash-registers/:id/approve` | Aprobar cierre con diferencia > RD$200 | admin |
| GET | `/cash-registers/:id/transactions` | Movimientos de una caja | operator, admin |
| GET | `/cash-registers/history` | Historial de cierres (filtros) | admin |

## Facturación
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/invoices` | Listar facturas (filtros: search, startDate, endDate) | operator, admin |
| GET | `/invoices/:id` | Detalle factura con NCF | operator, admin |
| GET | `/invoices/stats` | KPIs: total facturado, ITBIS, notas crédito | admin |
| POST | `/invoices/from-payment/:paymentId` | Generar factura manual | admin |

## Auditoría
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/audit` | Listar logs (filtros: userId, action, entityType, dates) | admin |
| GET | `/audit/actions` | Listar acciones distintas con conteo | admin |

## Reportes
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/reports/dashboard` | KPIs del dashboard | admin |
| GET | `/reports/active-vehicles` | Vehículos activos en el parqueo | admin |

## Settings
| Método | Ruta | Descripción | Roles |
|--------|------|-------------|-------|
| GET | `/settings` | Listar configuraciones | admin |
| GET | `/settings/:key` | Obtener valor | admin |
| PATCH | `/settings/:key` | Actualizar valor | admin |

---

## Parámetros de Negocio

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| `CASH_DIFF_THRESHOLD` | RD$200 | Diferencia de caja que requiere aprobación supervisor |
| `REFUND_LIMIT_OPERATOR` | RD$500 | Monto máximo reembolso sin aprobación admin |
| `TAX_RATE` | 18% | ITBIS aplicado a todos los cobros |
| `ALERT_EMAIL` | alonsoveloz@gmail.com | Email para alertas de caja |
| NCF B01 | Consumidor final | Serie provisional demo |
| NCF B14 | Valor fiscal (RNC) | Serie provisional demo |
| NCF B04 | Nota de crédito | Serie provisional demo |

## Flujos Automáticos

1. **Cobro → Factura**: Al procesar un pago exitoso, se genera factura con NCF automáticamente
2. **Reembolso → Nota de Crédito**: Al reembolsar, se genera nota de crédito NCF B04
3. **Cobro sesión → Caja**: Al cobrar en control de acceso, se registra en la caja abierta del operador
4. **Cierre caja → Alerta email**: Si la diferencia supera RD$200, se envía email al supervisor
5. **Toda mutación → Audit Log**: Pagos, reembolsos, apertura/cierre de caja quedan en audit_logs
