/**
 * ParkingPro Email Templates
 * 3 professional HTML email templates with consistent branding
 *
 * Templates:
 *   1. cash_alert        - Alerta de cuadre de caja
 *   2. payment_confirm   - Confirmación de pago
 *   3. subscription_expiry - Vencimiento de suscripción
 */

const BRAND = {
  name: 'ParkingPro',
  color: '#4F46E5',      // indigo-600
  colorDark: '#3730A3',  // indigo-800
  colorLight: '#EEF2FF', // indigo-50
  accent: '#F59E0B',     // amber-500
  danger: '#EF4444',     // red-500
  success: '#10B981',    // emerald-500
  gray: '#6B7280',
  grayLight: '#F3F4F6',
};

// ─── BASE LAYOUT ──────────────────────────────────────────────────────────────

function baseLayout({ title, preheader, bodyContent, footerExtra = '' }) {
  return `<!DOCTYPE html>
<html lang="es" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${title}</title>
  ${preheader ? `<!--[if !mso]><!--><span style="display:none;font-size:0;color:#fff;max-height:0;overflow:hidden">${preheader}</span><!--<![endif]-->` : ''}
  <style>
    body, table, td { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { margin: 0; padding: 0; background-color: #f3f4f6; -webkit-text-size-adjust: 100%; }
    table { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
    img { border: 0; display: block; outline: none; text-decoration: none; }
    .container { max-width: 600px; margin: 0 auto; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 10px; font-size: 15px; font-weight: 600; text-decoration: none; text-align: center; }
    .btn-primary { background-color: ${BRAND.color}; color: #ffffff !important; }
    .btn-danger { background-color: ${BRAND.danger}; color: #ffffff !important; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .stat-card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px 20px; text-align: center; }
    .divider { height: 1px; background: #e5e7eb; margin: 24px 0; }
    @media only screen and (max-width: 620px) {
      .container { width: 100% !important; padding: 0 16px !important; }
      .stat-row td { display: block !important; width: 100% !important; margin-bottom: 12px !important; }
      .mobile-full { width: 100% !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg, ${BRAND.color} 0%, ${BRAND.colorDark} 100%);background-color:${BRAND.color};">
    <tr>
      <td align="center" style="padding:32px 20px 28px;">
        <table class="container" width="600" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center">
              <div style="width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:12px;display:inline-block;text-align:center;line-height:48px;margin-bottom:12px;">
                <span style="font-size:24px;color:#fff;">P</span>
              </div>
              <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">${BRAND.name}</h1>
              <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.75);">Sistema de Gestión de Parqueos</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
    <tr>
      <td align="center" style="padding:0 20px;">
        <table class="container" width="600" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px 36px 36px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
              ${bodyContent}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
    <tr>
      <td align="center" style="padding:24px 20px 40px;">
        <table class="container" width="600" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center">
              ${footerExtra}
              <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;">Este email fue enviado automaticamente por ${BRAND.name}.</p>
              <p style="margin:0;font-size:12px;color:#9ca3af;">Si no esperabas este mensaje, puedes ignorarlo.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── TEMPLATE 1: ALERTA DE CUADRE DE CAJA ─────────────────────────────────────

function cashAlertTemplate(data) {
  const {
    registerName = 'Caja Principal',
    operatorName = 'Operador',
    closedAt = new Date().toLocaleString('es-DO'),
    openingBalance = 0,
    expectedBalance = 0,
    countedBalance = 0,
    difference = 0,
    transactionCount = 0,
    requiresApproval = true,
  } = data;

  const tipo = difference < 0 ? 'FALTANTE' : 'SOBRANTE';
  const tipoColor = difference < 0 ? BRAND.danger : BRAND.accent;
  const absDiff = Math.abs(difference).toFixed(2);

  const bodyContent = `
    <!-- Alert Banner -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:${difference < 0 ? '#FEF2F2' : '#FFFBEB'};border-radius:12px;padding:20px 24px;border-left:4px solid ${tipoColor};">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <span style="font-size:24px;line-height:1;">&#9888;&#65039;</span>
              </td>
              <td style="padding-left:12px;">
                <p style="margin:0;font-size:16px;font-weight:700;color:${tipoColor};">Alerta de Cuadre: ${tipo}</p>
                <p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Se detecto una diferencia en el cierre de caja</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <div style="height:24px;"></div>

    <!-- Info Row -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.grayLight};border-radius:10px;padding:4px;">
      <tr>
        <td style="padding:14px 20px;">
          <p style="margin:0;font-size:12px;color:${BRAND.gray};text-transform:uppercase;letter-spacing:0.5px;">Caja</p>
          <p style="margin:4px 0 0;font-size:15px;font-weight:600;color:#111827;">${registerName}</p>
        </td>
        <td style="padding:14px 20px;">
          <p style="margin:0;font-size:12px;color:${BRAND.gray};text-transform:uppercase;letter-spacing:0.5px;">Operador</p>
          <p style="margin:4px 0 0;font-size:15px;font-weight:600;color:#111827;">${operatorName}</p>
        </td>
        <td style="padding:14px 20px;">
          <p style="margin:0;font-size:12px;color:${BRAND.gray};text-transform:uppercase;letter-spacing:0.5px;">Cierre</p>
          <p style="margin:4px 0 0;font-size:15px;font-weight:600;color:#111827;">${closedAt}</p>
        </td>
      </tr>
    </table>

    <div style="height:24px;"></div>

    <!-- Stat Cards -->
    <table width="100%" cellpadding="0" cellspacing="0" class="stat-row">
      <tr>
        <td width="33%" style="padding:0 6px 0 0;">
          <div class="stat-card">
            <p style="margin:0;font-size:11px;color:${BRAND.gray};text-transform:uppercase;">Apertura</p>
            <p style="margin:6px 0 0;font-size:20px;font-weight:700;color:#111827;">RD$${parseFloat(openingBalance).toFixed(2)}</p>
          </div>
        </td>
        <td width="33%" style="padding:0 3px;">
          <div class="stat-card">
            <p style="margin:0;font-size:11px;color:${BRAND.gray};text-transform:uppercase;">Esperado</p>
            <p style="margin:6px 0 0;font-size:20px;font-weight:700;color:#111827;">RD$${parseFloat(expectedBalance).toFixed(2)}</p>
          </div>
        </td>
        <td width="33%" style="padding:0 0 0 6px;">
          <div class="stat-card">
            <p style="margin:0;font-size:11px;color:${BRAND.gray};text-transform:uppercase;">Contado</p>
            <p style="margin:6px 0 0;font-size:20px;font-weight:700;color:#111827;">RD$${parseFloat(countedBalance).toFixed(2)}</p>
          </div>
        </td>
      </tr>
    </table>

    <div style="height:20px;"></div>

    <!-- Difference Highlight -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="background:${difference < 0 ? '#FEF2F2' : '#FFFBEB'};border-radius:12px;padding:20px;">
          <p style="margin:0;font-size:12px;color:${BRAND.gray};text-transform:uppercase;letter-spacing:1px;">Diferencia</p>
          <p style="margin:8px 0 0;font-size:36px;font-weight:800;color:${tipoColor};letter-spacing:-1px;">
            ${difference < 0 ? '-' : '+'}RD$${absDiff}
          </p>
          <span class="badge" style="margin-top:8px;background:${tipoColor};color:#fff;">${tipo}</span>
          ${transactionCount > 0 ? `<p style="margin:12px 0 0;font-size:12px;color:${BRAND.gray};">${transactionCount} transacciones procesadas</p>` : ''}
        </td>
      </tr>
    </table>

    ${requiresApproval ? `
    <div style="height:24px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="background:#EEF2FF;border-radius:10px;padding:16px;">
          <p style="margin:0;font-size:13px;color:${BRAND.color};font-weight:500;">
            &#128274; Esta caja requiere <strong>aprobacion del supervisor</strong> antes de ser archivada.
          </p>
        </td>
      </tr>
    </table>
    ` : ''}

    <div style="height:28px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <a href="#" class="btn btn-primary" style="color:#ffffff;">Revisar en ParkingPro</a>
        </td>
      </tr>
    </table>
  `;

  return baseLayout({
    title: `[ParkingPro] Alerta de Caja: ${tipo} de RD$${absDiff}`,
    preheader: `${tipo} de RD$${absDiff} en ${registerName} - ${operatorName}`,
    bodyContent,
  });
}

// ─── TEMPLATE 2: CONFIRMACION DE PAGO ─────────────────────────────────────────

function paymentConfirmTemplate(data) {
  const {
    customerName = 'Cliente',
    receiptNumber = '',
    paymentDate = new Date().toLocaleString('es-DO'),
    planName = 'Parqueo por hora',
    paymentMethod = 'Efectivo',
    subtotal = 0,
    taxRate = 18,
    taxAmount = 0,
    totalAmount = 0,
    vehiclePlate = '',
    nextBillingDate = '',
    ncf = '',
  } = data;

  const methodLabel = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    efectivo: 'Efectivo',
    tarjeta: 'Tarjeta',
  }[paymentMethod?.toLowerCase()] || paymentMethod;

  const bodyContent = `
    <!-- Success Header -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding-bottom:24px;">
          <div style="width:64px;height:64px;background:#D1FAE5;border-radius:50%;display:inline-block;text-align:center;line-height:64px;">
            <span style="font-size:32px;">&#10003;</span>
          </div>
          <h2 style="margin:16px 0 4px;font-size:22px;font-weight:700;color:#111827;">Pago Confirmado</h2>
          <p style="margin:0;font-size:14px;color:${BRAND.gray};">Tu pago ha sido procesado exitosamente</p>
        </td>
      </tr>
    </table>

    <div class="divider"></div>

    <!-- Customer & Details -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding-bottom:20px;">
          <p style="margin:0;font-size:12px;color:${BRAND.gray};text-transform:uppercase;letter-spacing:0.5px;">Cliente</p>
          <p style="margin:4px 0 0;font-size:16px;font-weight:600;color:#111827;">${customerName}</p>
        </td>
        <td align="right" style="padding-bottom:20px;">
          ${receiptNumber ? `
          <p style="margin:0;font-size:12px;color:${BRAND.gray};text-transform:uppercase;letter-spacing:0.5px;">Recibo</p>
          <p style="margin:4px 0 0;font-size:16px;font-weight:600;color:${BRAND.color};">#${receiptNumber}</p>
          ` : ''}
        </td>
      </tr>
    </table>

    <!-- Receipt Details -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.grayLight};border-radius:12px;">
      <tr>
        <td style="padding:20px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:8px 0;font-size:14px;color:${BRAND.gray};">Plan / Concepto</td>
              <td align="right" style="padding:8px 0;font-size:14px;font-weight:600;color:#111827;">${planName}</td>
            </tr>
            ${vehiclePlate ? `
            <tr>
              <td style="padding:8px 0;font-size:14px;color:${BRAND.gray};">Vehiculo</td>
              <td align="right" style="padding:8px 0;font-size:14px;font-weight:600;color:#111827;">${vehiclePlate}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:8px 0;font-size:14px;color:${BRAND.gray};">Metodo de Pago</td>
              <td align="right" style="padding:8px 0;font-size:14px;font-weight:600;color:#111827;">${methodLabel}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-size:14px;color:${BRAND.gray};">Fecha</td>
              <td align="right" style="padding:8px 0;font-size:14px;font-weight:600;color:#111827;">${paymentDate}</td>
            </tr>
            ${ncf ? `
            <tr>
              <td style="padding:8px 0;font-size:14px;color:${BRAND.gray};">NCF</td>
              <td align="right" style="padding:8px 0;font-size:14px;font-weight:600;color:#111827;">${ncf}</td>
            </tr>` : ''}
          </table>

          <div style="height:1px;background:#e5e7eb;margin:12px 0;"></div>

          <!-- Amounts -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:6px 0;font-size:14px;color:${BRAND.gray};">Subtotal</td>
              <td align="right" style="padding:6px 0;font-size:14px;color:#374151;">RD$${parseFloat(subtotal).toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-size:14px;color:${BRAND.gray};">ITBIS (${taxRate}%)</td>
              <td align="right" style="padding:6px 0;font-size:14px;color:#374151;">RD$${parseFloat(taxAmount).toFixed(2)}</td>
            </tr>
          </table>

          <div style="height:1px;background:#d1d5db;margin:12px 0;"></div>

          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:4px 0;font-size:18px;font-weight:700;color:#111827;">Total</td>
              <td align="right" style="padding:4px 0;font-size:24px;font-weight:800;color:${BRAND.color};">RD$${parseFloat(totalAmount).toFixed(2)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${nextBillingDate ? `
    <div style="height:20px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:${BRAND.colorLight};border-radius:10px;padding:14px 20px;">
          <p style="margin:0;font-size:13px;color:${BRAND.color};">
            &#128197; Proxima fecha de facturacion: <strong>${nextBillingDate}</strong>
          </p>
        </td>
      </tr>
    </table>
    ` : ''}

    <div style="height:28px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <p style="margin:0 0 8px;font-size:12px;color:${BRAND.gray};">Gracias por tu pago</p>
          <a href="#" class="btn btn-primary" style="color:#ffffff;">Ver mi cuenta</a>
        </td>
      </tr>
    </table>
  `;

  return baseLayout({
    title: `[ParkingPro] Confirmacion de Pago - RD$${parseFloat(totalAmount).toFixed(2)}`,
    preheader: `Pago de RD$${parseFloat(totalAmount).toFixed(2)} confirmado - ${planName}`,
    bodyContent,
  });
}

// ─── TEMPLATE 3: VENCIMIENTO DE SUSCRIPCION ───────────────────────────────────

function subscriptionExpiryTemplate(data) {
  const {
    customerName = 'Cliente',
    planName = 'Plan Mensual',
    vehiclePlate = '',
    expiryDate = '',
    daysRemaining = 0,
    pricePerPeriod = 0,
    renewalUrl = '#',
    isExpired = false,
  } = data;

  const urgencyColor = isExpired ? BRAND.danger : (daysRemaining <= 3 ? BRAND.accent : BRAND.color);
  const urgencyBg = isExpired ? '#FEF2F2' : (daysRemaining <= 3 ? '#FFFBEB' : BRAND.colorLight);
  const statusText = isExpired ? 'Vencida' : `Vence en ${daysRemaining} dia${daysRemaining !== 1 ? 's' : ''}`;
  const statusEmoji = isExpired ? '&#128308;' : (daysRemaining <= 3 ? '&#128992;' : '&#128994;');

  const bodyContent = `
    <!-- Greeting -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#111827;">Hola, ${customerName}</h2>
          <p style="margin:0;font-size:14px;color:${BRAND.gray};">
            ${isExpired
              ? 'Tu suscripcion ha vencido. Renuevala para seguir disfrutando del servicio.'
              : 'Te recordamos que tu suscripcion esta proxima a vencer.'}
          </p>
        </td>
      </tr>
    </table>

    <div style="height:24px;"></div>

    <!-- Status Banner -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:${urgencyBg};border-radius:12px;padding:20px 24px;text-align:center;border:1px solid ${isExpired ? '#FECACA' : (daysRemaining <= 3 ? '#FDE68A' : '#C7D2FE')};">
          <p style="margin:0;font-size:32px;line-height:1;">${statusEmoji}</p>
          <p style="margin:12px 0 4px;font-size:24px;font-weight:800;color:${urgencyColor};">${statusText}</p>
          <p style="margin:0;font-size:13px;color:${BRAND.gray};">Fecha de vencimiento: <strong>${expiryDate}</strong></p>
        </td>
      </tr>
    </table>

    <div style="height:24px;"></div>

    <!-- Subscription Details -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.grayLight};border-radius:12px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 16px;font-size:13px;font-weight:600;color:${BRAND.gray};text-transform:uppercase;letter-spacing:0.5px;">Detalles de la Suscripcion</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:10px 0;font-size:14px;color:${BRAND.gray};border-bottom:1px solid #e5e7eb;">Plan</td>
              <td align="right" style="padding:10px 0;font-size:14px;font-weight:600;color:#111827;border-bottom:1px solid #e5e7eb;">${planName}</td>
            </tr>
            ${vehiclePlate ? `
            <tr>
              <td style="padding:10px 0;font-size:14px;color:${BRAND.gray};border-bottom:1px solid #e5e7eb;">Vehiculo</td>
              <td align="right" style="padding:10px 0;font-size:14px;font-weight:600;color:#111827;border-bottom:1px solid #e5e7eb;">${vehiclePlate}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:10px 0;font-size:14px;color:${BRAND.gray};border-bottom:1px solid #e5e7eb;">Vencimiento</td>
              <td align="right" style="padding:10px 0;font-size:14px;font-weight:600;color:${urgencyColor};border-bottom:1px solid #e5e7eb;">${expiryDate}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;font-size:14px;color:${BRAND.gray};">Monto a Renovar</td>
              <td align="right" style="padding:10px 0;font-size:20px;font-weight:700;color:${BRAND.color};">RD$${parseFloat(pricePerPeriod).toFixed(2)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <div style="height:28px;"></div>

    <!-- CTA -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <a href="${renewalUrl}" class="btn ${isExpired ? 'btn-danger' : 'btn-primary'}" style="color:#ffffff;">
            ${isExpired ? 'Renovar Ahora' : 'Renovar Suscripcion'}
          </a>
          ${!isExpired ? `<p style="margin:12px 0 0;font-size:12px;color:${BRAND.gray};">Renueva antes del ${expiryDate} para evitar interrupciones</p>` : ''}
        </td>
      </tr>
    </table>

    ${isExpired ? `
    <div style="height:20px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#FEF2F2;border-radius:10px;padding:14px 20px;">
          <p style="margin:0;font-size:13px;color:${BRAND.danger};">
            &#9888;&#65039; Tu acceso al parqueo esta <strong>suspendido</strong> hasta que renueves tu suscripcion.
          </p>
        </td>
      </tr>
    </table>
    ` : ''}
  `;

  return baseLayout({
    title: `[ParkingPro] ${isExpired ? 'Suscripcion Vencida' : 'Tu suscripcion vence pronto'} - ${planName}`,
    preheader: `${isExpired ? 'Tu suscripcion ha vencido' : `Tu suscripcion vence en ${daysRemaining} dias`} - ${planName}`,
    bodyContent,
  });
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

const TEMPLATES = {
  cash_alert: cashAlertTemplate,
  payment_confirm: paymentConfirmTemplate,
  subscription_expiry: subscriptionExpiryTemplate,
};

/**
 * Render an email template by ID
 * @param {string} templateId - One of: cash_alert, payment_confirm, subscription_expiry
 * @param {object} data - Template-specific data
 * @returns {{ html: string, subject: string }}
 */
function renderTemplate(templateId, data = {}) {
  const fn = TEMPLATES[templateId];
  if (!fn) {
    throw new Error(`Email template "${templateId}" not found. Available: ${Object.keys(TEMPLATES).join(', ')}`);
  }
  const html = fn(data);
  // Extract subject from <title> tag
  const subjectMatch = html.match(/<title>([^<]+)<\/title>/);
  const subject = subjectMatch ? subjectMatch[1] : `[ParkingPro] Notificacion`;
  return { html, subject };
}

module.exports = {
  renderTemplate,
  TEMPLATES,
  cashAlertTemplate,
  paymentConfirmTemplate,
  subscriptionExpiryTemplate,
};
