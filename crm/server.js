const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCampaignWhere({ cliente, producto, ciudad, contacto } = {}) {
  const where = [];
  const params = [];
  if (cliente)  { where.push('cliente = ?');        params.push(cliente); }
  if (producto) { where.push('producto LIKE ?');     params.push(`%${producto}%`); }
  if (ciudad)   { where.push('ciudad = ?');          params.push(ciudad); }
  if (contacto === 'solo_email')    where.push("email IS NOT NULL AND email != ''");
  if (contacto === 'solo_telefono') where.push("telefono IS NOT NULL AND telefono != ''");
  if (contacto === 'ambos')         where.push("email IS NOT NULL AND email != '' AND telefono IS NOT NULL AND telefono != ''");
  return { whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function addCond(wc, cond) {
  return wc ? `${wc} AND ${cond}` : `WHERE ${cond}`;
}

function tplReplace(text, lead) {
  return text
    .replace(/\{nombre\}/g,  lead.nombre  || 'Estimado/a')
    .replace(/\{empresa\}/g, lead.empresa || lead.nombre || '')
    .replace(/\{ciudad\}/g,  lead.ciudad  || '')
    .replace(/\{rubro\}/g,   lead.rubro   || 'su negocio');
}

async function sendResendEmail({ to, from, subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return r.json();
}

async function extractEmailFromWebsite(url) {
  if (!url) return '';
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
    });
    clearTimeout(tid);
    const html = await r.text();
    const match = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (!match) return '';
    const email = match[0].toLowerCase();
    // filter common false positives
    if (/example\.|sentry\.|w3\.org|schema\.org|wix\.com/.test(email)) return '';
    return email;
  } catch {
    return '';
  }
}

// ── Google Places API (New) helpers ──────────────────────────────────────────

const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
].join(',');

async function placesTextSearch(query, apiKey) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'es' }),
  });
  return r.json();
}

async function saveLeadJS(lead) {
  const [[dup]] = await pool.query(
    `SELECT id FROM leads WHERE
     (telefono != '' AND telefono IS NOT NULL AND telefono = ?) OR
     (nombre = ? AND ciudad = ? AND fuente = 'google_maps')
     LIMIT 1`,
    [lead.telefono || '', lead.nombre, lead.ciudad]
  );
  if (dup) return false;
  await pool.query(
    `INSERT INTO leads
     (nombre, empresa, rubro, telefono, email, ciudad, direccion,
      website, rating, total_reviews, fuente, cliente, producto)
     VALUES (?,?,?,?,?,?,?,?,?,?,'google_maps',?,?)`,
    [
      lead.nombre, lead.nombre, lead.rubro,
      lead.telefono || '', lead.email || '', lead.ciudad, lead.direccion || '',
      lead.website || '', lead.rating ?? null, lead.total_reviews || 0,
      lead.cliente, lead.producto,
    ]
  );
  return true;
}

// ── Leads CRUD ────────────────────────────────────────────────────────────────

app.get('/api/leads', async (req, res) => {
  try {
    const { estado, ciudad, cliente, producto, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const where = [];
    const params = [];
    if (estado)  { where.push('estado = ?');   params.push(estado); }
    if (ciudad)  { where.push('ciudad = ?');   params.push(ciudad); }
    if (cliente) { where.push('cliente = ?');  params.push(cliente); }
    if (producto){ where.push('producto = ?'); params.push(producto); }
    if (search) {
      where.push('(nombre LIKE ? OR empresa LIKE ? OR email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [leads] = await pool.query(
      `SELECT * FROM leads ${wc} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM leads ${wc}`, params);
    res.json({ leads, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lead no encontrado' });
    const [contactos] = await pool.query(
      'SELECT * FROM contactos WHERE lead_id = ? ORDER BY fecha DESC', [req.params.id]
    );
    const [emails] = await pool.query(
      'SELECT * FROM emails_enviados WHERE lead_id = ? ORDER BY enviado_at DESC', [req.params.id]
    );
    res.json({ ...rows[0], contactos, emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads — crear lead manual
app.post('/api/leads', async (req, res) => {
  try {
    const {
      nombre, empresa, telefono, email, ciudad, rubro,
      estado = 'nuevo', notas, website, cliente = 'Conecta CSur', producto = '',
    } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
    const [result] = await pool.query(
      `INSERT INTO leads
       (nombre, empresa, rubro, telefono, email, ciudad, website, estado, notas, fuente, cliente, producto)
       VALUES (?,?,?,?,?,?,?,?,?,'manual',?,?)`,
      [nombre, empresa || nombre, rubro || '', telefono || '', email || '',
       ciudad || '', website || '', estado, notas || '', cliente, producto]
    );
    const [rows] = await pool.query('SELECT * FROM leads WHERE id = ?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const allowed = ['nombre','empresa','telefono','email','ciudad','rubro','estado','notas','website','cliente','producto'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Sin campos para actualizar' });
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await pool.query(`UPDATE leads SET ${sets} WHERE id = ?`, [...Object.values(updates), req.params.id]);
    const [rows] = await pool.query('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/:id/contactos', async (req, res) => {
  try {
    const { tipo, asunto, contenido, resultado } = req.body;
    const [result] = await pool.query(
      'INSERT INTO contactos (lead_id, tipo, asunto, contenido, resultado) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, tipo, asunto, contenido, resultado]
    );
    if (req.body.nuevo_estado) {
      await pool.query('UPDATE leads SET estado = ? WHERE id = ?', [req.body.nuevo_estado, req.params.id]);
    }
    res.json({ id: result.insertId, lead_id: req.params.id, tipo, asunto, contenido, resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats & Clientes ──────────────────────────────────────────────────────────

app.get('/api/stats', async (_req, res) => {
  try {
    const [byEstado] = await pool.query('SELECT estado, COUNT(*) as total FROM leads GROUP BY estado');
    const [byRubro]  = await pool.query('SELECT rubro, COUNT(*) as total FROM leads GROUP BY rubro ORDER BY total DESC LIMIT 10');
    const [byCiudad] = await pool.query('SELECT ciudad, COUNT(*) as total FROM leads GROUP BY ciudad ORDER BY total DESC LIMIT 10');
    const [[{ total_leads }]]     = await pool.query('SELECT COUNT(*) as total_leads FROM leads');
    const [[{ emails_enviados }]] = await pool.query('SELECT COUNT(*) as emails_enviados FROM emails_enviados');
    res.json({ total_leads, emails_enviados, by_estado: byEstado, by_rubro: byRubro, by_ciudad: byCiudad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clientes', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT cliente FROM leads WHERE cliente IS NOT NULL AND cliente != '' ORDER BY cliente"
    );
    res.json(rows.map(r => r.cliente));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Campaña masiva ────────────────────────────────────────────────────────────

app.post('/api/campaign/preview', async (req, res) => {
  try {
    const { whereClause, params } = buildCampaignWhere(req.body);
    const [[{ total }]]       = await pool.query(`SELECT COUNT(*) as total FROM leads ${whereClause}`, params);
    const [[{ con_email }]]   = await pool.query(`SELECT COUNT(*) as con_email FROM leads ${addCond(whereClause, "email IS NOT NULL AND email != ''")}`, params);
    const [[{ con_telefono }]]= await pool.query(`SELECT COUNT(*) as con_telefono FROM leads ${addCond(whereClause, "telefono IS NOT NULL AND telefono != ''")}`, params);
    res.json({ total, con_email, con_telefono });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign/email', async (req, res) => {
  try {
    const { filtros = {}, asunto, cuerpo, limite = 100 } = req.body;
    if (!asunto || !cuerpo) return res.status(400).json({ error: 'asunto y cuerpo son requeridos' });
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });
    const from = process.env.RESEND_FROM || 'ventas@conectacsur.cl';

    const { whereClause, params } = buildCampaignWhere(filtros);
    const emailWC = addCond(whereClause, "email IS NOT NULL AND email != ''");
    const [leads] = await pool.query(
      `SELECT id, nombre, empresa, email, ciudad, rubro FROM leads ${emailWC} ORDER BY created_at DESC LIMIT ?`,
      [...params, parseInt(limite)]
    );

    let enviados = 0, errores = 0;
    for (const lead of leads) {
      const subject = tplReplace(asunto, lead);
      const html    = tplReplace(cuerpo, lead);
      try {
        const result = await sendResendEmail({ to: lead.email, from, subject, html });
        if (result.id) {
          await pool.query(
            'INSERT INTO emails_enviados (lead_id, email_destino, asunto, contenido, estado, resend_id) VALUES (?,?,?,?,?,?)',
            [lead.id, lead.email, subject, html.substring(0, 500), 'enviado', result.id]
          );
          await pool.query("UPDATE leads SET estado='contactado' WHERE id=? AND estado='nuevo'", [lead.id]);
          enviados++;
        } else {
          errores++;
        }
      } catch { errores++; }
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ enviados, errores, total: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign/export-whatsapp', async (req, res) => {
  try {
    const { filtros = {} } = req.body;
    const { whereClause, params } = buildCampaignWhere(filtros);
    const phoneWC = addCond(whereClause, "telefono IS NOT NULL AND telefono != ''");
    const [leads] = await pool.query(
      `SELECT nombre, empresa, telefono, email, ciudad, rubro FROM leads ${phoneWC} ORDER BY nombre`,
      params
    );
    const esc = s => `"${(s || '').replace(/"/g, '""')}"`;
    const csv = [
      'nombre,empresa,telefono,email,ciudad,rubro',
      ...leads.map(l => [esc(l.nombre),esc(l.empresa),esc(l.telefono),esc(l.email),esc(l.ciudad),esc(l.rubro)].join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads-whatsapp.csv"');
    res.send('﻿' + csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scraper (Google Places API + extracción de email) ─────────────────────────

app.post('/api/scraper/run', async (req, res) => {
  const {
    rubro, ciudad, max = 15, producto = '',
    cliente = 'Conecta CSur', buscar_con = 'solo_telefono',
  } = req.body;

  if (!rubro || !ciudad) return res.status(400).json({ error: 'rubro y ciudad son requeridos' });

  const safePattern = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s\-\.]+$/;
  if (!safePattern.test(rubro) || !safePattern.test(ciudad)) {
    return res.status(400).json({ error: 'rubro y ciudad solo pueden contener letras, espacios y guiones' });
  }

  const maxInt = Math.min(Math.max(parseInt(max) || 15, 1), 100);
  const extractEmail = buscar_con === 'solo_email' || buscar_con === 'telefono_email';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'start', rubro, ciudad, max: maxInt });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    send({ type: 'err', line: 'ERROR: GOOGLE_API_KEY no configurado en Railway Variables.' });
    send({ type: 'err', line: '→ Activa "Places API (New)" en console.cloud.google.com y agrega la clave.' });
    send({ type: 'done', code: 1 });
    return res.end();
  }

  try {
    send({ type: 'log', line: `Buscando: "${rubro}" en ${ciudad}...` });
    const searchData = await placesTextSearch(`${rubro} en ${ciudad}`, apiKey);

    if (searchData.error) {
      const { code, message } = searchData.error;
      send({ type: 'err', line: `Google API error ${code}: ${message}` });
      send({ type: 'done', code: 1 });
      return res.end();
    }

    const places = (searchData.places || []).slice(0, maxInt);
    send({ type: 'log', line: `Encontrados: ${places.length} resultados${extractEmail ? ' — extrayendo emails de websites...' : ''}` });

    let saved = 0, dups = 0;

    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      const nombre  = p.displayName?.text || '';
      const phone   = p.nationalPhoneNumber || '';
      const website = p.websiteUri || '';
      const stars   = p.rating ? `⭐ ${p.rating}` : '';

      let email = '';
      if (extractEmail && website) {
        email = await extractEmailFromWebsite(website);
      }

      const ok = await saveLeadJS({
        nombre, rubro, ciudad,
        direccion: p.formattedAddress || '',
        telefono: phone, email, website,
        rating: p.rating ?? null,
        total_reviews: p.userRatingCount || 0,
        cliente, producto,
      });

      ok ? saved++ : dups++;
      const info = [phone, email ? `📧 ${email}` : '', stars].filter(Boolean).join(' | ');
      send({ type: 'log', line: `[${i + 1}] ${ok ? 'GUARDADO' : 'DUPLICADO'}: ${nombre} | ${info}` });
    }

    send({ type: 'log', line: `\n→ ${saved} guardados, ${dups} duplicados` });
    send({ type: 'done', code: 0 });
    res.end();
  } catch (err) {
    send({ type: 'err', line: `Error inesperado: ${err.message}` });
    send({ type: 'done', code: 1 });
    res.end();
  }
});

app.get('/api/scraper/scripts', (_req, res) => {
  res.json({ scripts: ['google_maps'] });
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CRM Pipeline corriendo en http://0.0.0.0:${PORT}`);
});

module.exports = app;
