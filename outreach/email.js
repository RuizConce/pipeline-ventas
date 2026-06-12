const { Resend } = require('resend');
const mysql = require('mysql2/promise');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

function buildEmailHtml(lead, template) {
  return template
    .replace(/\{\{nombre\}\}/g, lead.nombre || 'Estimado/a')
    .replace(/\{\{empresa\}\}/g, lead.empresa || lead.nombre)
    .replace(/\{\{rubro\}\}/g, lead.rubro || 'su negocio')
    .replace(/\{\{ciudad\}\}/g, lead.ciudad || '');
}

const TEMPLATE_PRESENTACION = {
  asunto: 'Solución digital para {{empresa}} - ConectaCSur',
  html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Hola {{nombre}},</h2>
      <p>Me contacto desde <strong>ConectaCSur</strong>, empresa especializada en soluciones digitales
      para negocios en {{ciudad}}.</p>
      <p>Vimos que <strong>{{empresa}}</strong> está en el rubro de <em>{{rubro}}</em> y creemos que
      podemos ayudarles a:</p>
      <ul>
        <li>✅ Aumentar la visibilidad online</li>
        <li>✅ Automatizar la captación de clientes</li>
        <li>✅ Gestionar su pipeline de ventas de forma eficiente</li>
      </ul>
      <p>¿Les interesaría una llamada de 15 minutos para conocer más?</p>
      <p>Quedo atento/a a su respuesta.</p>
      <hr style="border: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #6b7280; font-size: 0.875rem;">
        ConectaCSur | ventas@conectacsur.cl<br>
        <a href="mailto:ventas@conectacsur.cl?subject=No quiero recibir más emails" style="color: #9ca3af;">
          Cancelar suscripción
        </a>
      </p>
    </div>
  `,
};

async function sendEmailToLead(leadId, templateName = 'presentacion') {
  const [rows] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (!rows.length) throw new Error(`Lead ${leadId} no encontrado`);

  const lead = rows[0];
  if (!lead.email) throw new Error(`Lead ${leadId} no tiene email`);

  const template = templateName === 'presentacion' ? TEMPLATE_PRESENTACION : TEMPLATE_PRESENTACION;
  const asunto = buildEmailHtml(lead, template.asunto).replace(/<[^>]*>/g, '');
  const html = buildEmailHtml(lead, template.html);

  let resendId = null;
  let estado = 'enviado';

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM || 'ventas@conectacsur.cl',
      to: lead.email,
      subject: asunto,
      html,
    });

    if (error) throw new Error(error.message);
    resendId = data?.id;
    console.log(`✓ Email enviado a ${lead.email} (lead #${leadId}) | ID: ${resendId}`);
  } catch (err) {
    estado = 'error';
    console.error(`✗ Error enviando a ${lead.email}: ${err.message}`);
  }

  await pool.query(
    `INSERT INTO emails_enviados (lead_id, email_destino, asunto, contenido, estado, resend_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [leadId, lead.email, asunto, html, estado, resendId]
  );

  if (estado === 'enviado') {
    await pool.query(
      "UPDATE leads SET estado = 'contactado' WHERE id = ? AND estado = 'nuevo'",
      [leadId]
    );
  }

  return { leadId, email: lead.email, estado, resendId };
}

async function sendBulkEmails(filtros = {}, templateName = 'presentacion', limite = 50) {
  let where = ["email != '' AND email IS NOT NULL", "estado = 'nuevo'"];
  let params = [];

  if (filtros.ciudad) { where.push('ciudad = ?'); params.push(filtros.ciudad); }
  if (filtros.rubro) { where.push('rubro LIKE ?'); params.push(`%${filtros.rubro}%`); }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const [leads] = await pool.query(
    `SELECT id FROM leads ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    [...params, limite]
  );

  console.log(`Enviando a ${leads.length} leads...`);

  const results = [];
  for (const { id } of leads) {
    const result = await sendEmailToLead(id, templateName);
    results.push(result);
    await new Promise(r => setTimeout(r, 500)); // throttle: 2 emails/seg
  }

  const ok = results.filter(r => r.estado === 'enviado').length;
  const err = results.filter(r => r.estado === 'error').length;
  console.log(`\nResumen: ${ok} enviados, ${err} errores`);
  return results;
}

// Ejecutar directamente: node outreach/email.js bulk --ciudad=Temuco --limite=20
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  const getArg = (name) => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : undefined;
  };

  if (cmd === 'bulk') {
    const filtros = {};
    if (getArg('ciudad')) filtros.ciudad = getArg('ciudad');
    if (getArg('rubro')) filtros.rubro = getArg('rubro');
    const limite = parseInt(getArg('limite') || '50');
    sendBulkEmails(filtros, 'presentacion', limite)
      .then(() => process.exit(0))
      .catch(e => { console.error(e); process.exit(1); });
  } else if (cmd === 'single' && getArg('lead')) {
    sendEmailToLead(parseInt(getArg('lead')))
      .then(r => { console.log(r); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  } else {
    console.log('Uso: node outreach/email.js bulk [--ciudad=X] [--rubro=X] [--limite=N]');
    console.log('     node outreach/email.js single --lead=ID');
    process.exit(1);
  }
}

module.exports = { sendEmailToLead, sendBulkEmails };
