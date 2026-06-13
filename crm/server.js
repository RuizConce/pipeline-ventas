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

// GET /api/leads — listar leads con filtros opcionales
app.get('/api/leads', async (req, res) => {
  try {
    const { estado, ciudad, cliente, producto, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = [];
    let params = [];

    if (estado) { where.push('estado = ?'); params.push(estado); }
    if (ciudad) { where.push('ciudad = ?'); params.push(ciudad); }
    if (cliente) { where.push('cliente = ?'); params.push(cliente); }
    if (producto) { where.push('producto = ?'); params.push(producto); }
    if (search) {
      where.push('(nombre LIKE ? OR empresa LIKE ? OR email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [leads] = await pool.query(
      `SELECT * FROM leads ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM leads ${whereClause}`,
      params
    );

    res.json({ leads, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id
app.get('/api/leads/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lead no encontrado' });

    const [contactos] = await pool.query(
      'SELECT * FROM contactos WHERE lead_id = ? ORDER BY fecha DESC',
      [req.params.id]
    );
    const [emails] = await pool.query(
      'SELECT * FROM emails_enviados WHERE lead_id = ? ORDER BY enviado_at DESC',
      [req.params.id]
    );

    res.json({ ...rows[0], contactos, emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/leads/:id — actualizar estado o datos
app.put('/api/leads/:id', async (req, res) => {
  try {
    const allowed = ['nombre', 'empresa', 'telefono', 'email', 'ciudad', 'rubro', 'estado', 'notas', 'website', 'cliente', 'producto'];
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

// POST /api/leads/:id/contactos — registrar contacto
app.post('/api/leads/:id/contactos', async (req, res) => {
  try {
    const { tipo, asunto, contenido, resultado } = req.body;
    const [result] = await pool.query(
      'INSERT INTO contactos (lead_id, tipo, asunto, contenido, resultado) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, tipo, asunto, contenido, resultado]
    );

    // Actualizar estado del lead si se provee
    if (req.body.nuevo_estado) {
      await pool.query('UPDATE leads SET estado = ? WHERE id = ?', [req.body.nuevo_estado, req.params.id]);
    }

    res.json({ id: result.insertId, lead_id: req.params.id, tipo, asunto, contenido, resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — estadísticas del pipeline
app.get('/api/stats', async (req, res) => {
  try {
    const [byEstado] = await pool.query(
      'SELECT estado, COUNT(*) as total FROM leads GROUP BY estado'
    );
    const [byRubro] = await pool.query(
      'SELECT rubro, COUNT(*) as total FROM leads GROUP BY rubro ORDER BY total DESC LIMIT 10'
    );
    const [byCiudad] = await pool.query(
      'SELECT ciudad, COUNT(*) as total FROM leads GROUP BY ciudad ORDER BY total DESC LIMIT 10'
    );
    const [[{ total_leads }]] = await pool.query('SELECT COUNT(*) as total_leads FROM leads');
    const [[{ emails_enviados }]] = await pool.query('SELECT COUNT(*) as emails_enviados FROM emails_enviados');

    res.json({ total_leads, emails_enviados, by_estado: byEstado, by_rubro: byRubro, by_ciudad: byCiudad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id
app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Places API (New) helpers ─────────────────────────────────────────

const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
].join(',');

async function placesTextSearch(query, apiKey, pageToken) {
  const body = { textQuery: query, languageCode: 'es' };
  if (pageToken) body.pageToken = pageToken;

  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
    body: JSON.stringify(body),
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
     VALUES (?,?,?,?,'',?,?,?,?,?,'google_maps',?,?)`,
    [
      lead.nombre, lead.nombre, lead.rubro,
      lead.telefono || '', lead.ciudad, lead.direccion || '',
      lead.website || '', lead.rating ?? null, lead.total_reviews || 0,
      lead.cliente, lead.producto,
    ]
  );
  return true;
}

// POST /api/scraper/run — Google Places API desde Node.js, SSE en tiempo real
app.post('/api/scraper/run', async (req, res) => {
  const { rubro, ciudad, max = 15, producto = '', cliente = 'Conecta CSur' } = req.body;

  if (!rubro || !ciudad) {
    return res.status(400).json({ error: 'rubro y ciudad son requeridos' });
  }

  const safePattern = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s\-\.]+$/;
  if (!safePattern.test(rubro) || !safePattern.test(ciudad)) {
    return res.status(400).json({ error: 'rubro y ciudad solo pueden contener letras, espacios y guiones' });
  }

  const maxInt = Math.min(Math.max(parseInt(max) || 15, 1), 100);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'start', rubro, ciudad, max: maxInt });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    send({ type: 'err', line: 'ERROR: GOOGLE_API_KEY no configurado en Railway Variables.' });
    send({ type: 'err', line: '→ Activa "Places API" en console.cloud.google.com y agrega la clave.' });
    send({ type: 'done', code: 1 });
    return res.end();
  }

  try {
    send({ type: 'log', line: `Buscando: "${rubro}" en ${ciudad}...` });

    const searchData = await placesTextSearch(`${rubro} en ${ciudad}`, apiKey);

    // La nueva API devuelve error como objeto con campo 'error'
    if (searchData.error) {
      const { code, message } = searchData.error;
      send({ type: 'err', line: `Google API error ${code}: ${message}` });
      send({ type: 'done', code: 1 });
      return res.end();
    }

    const places = (searchData.places || []).slice(0, maxInt);
    send({ type: 'log', line: `Encontrados: ${places.length} resultados` });

    let saved = 0, dups = 0;

    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      // Nueva API: campos con nombres distintos a la legacy
      const nombre  = p.displayName?.text || '';
      const phone   = p.nationalPhoneNumber || '';
      const website = p.websiteUri || '';
      const stars   = p.rating ? `⭐ ${p.rating}` : '';

      const ok = await saveLeadJS({
        nombre, rubro, ciudad,
        direccion: p.formattedAddress || '',
        telefono: phone, website,
        rating: p.rating ?? null,
        total_reviews: p.userRatingCount || 0,
        cliente, producto,
      });

      ok ? saved++ : dups++;
      send({ type: 'log', line: `[${i + 1}] ${ok ? 'GUARDADO' : 'DUPLICADO'}: ${nombre} | ${phone} | ${stars}` });
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

// GET /api/scraper/scripts
app.get('/api/scraper/scripts', (_req, res) => {
  res.json({ scripts: ['google_maps'] });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CRM Pipeline corriendo en http://0.0.0.0:${PORT}`);
});

module.exports = app;
