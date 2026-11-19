// Ankleide – Prototyp-Server
// Liefert die Web-App aus und leitet KI-Anfragen an die Google Gemini API weiter.
// Der API-Schlüssel bleibt auf dem Server (Umgebungsvariable GEMINI_API_KEY oder Datei .env)
// und landet nie im Browser.
//
// Start:  node server.js     (Node.js 18 oder neuer, keine weiteren Pakete nötig)

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- .env einlesen (optional) ------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY || '';
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
const BASE_URL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

// --- Gemini-Hilfsfunktionen ---------------------------------------------------
async function gemini(model, parts, generationConfig = {}) {
  if (!API_KEY) throw httpError(500, 'Kein GEMINI_API_KEY gesetzt. Siehe README.');
  const res = await fetch(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini-Fehler ${res.status}`;
    throw httpError(502, msg);
  }
  const outParts = data?.candidates?.[0]?.content?.parts || [];
  if (!outParts.length) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'unbekannt';
    throw httpError(502, `Gemini hat nichts zurückgegeben (Grund: ${reason}).`);
  }
  return outParts;
}

function img(image) {
  return { inline_data: { mime_type: image.mime || 'image/jpeg', data: image.data } };
}

async function geminiJson(parts) {
  const out = await gemini(TEXT_MODEL, parts, { responseMimeType: 'application/json', temperature: 0.6 });
  const text = out.map(p => p.text || '').join('');
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw httpError(502, 'Antwort von Gemini war kein gültiges JSON.');
  }
}

// --- Endpunkte -----------------------------------------------------------------
const CATEGORIES = ['Oberteil', 'Hose', 'Rock', 'Kleid', 'Pullover', 'Jacke', 'Mantel', 'Anzug/Sakko', 'Schuhe', 'Accessoire'];

async function tagItem({ image }) {
  const prompt = `Du bist Mode-Assistent. Analysiere das Kleidungsstück auf dem Foto.
Antworte NUR mit JSON in diesem Format:
{"category": eine aus ${JSON.stringify(CATEGORIES)},
 "name": kurzer deutscher Name, z.B. "Hellblaues Oxford-Hemd",
 "color": Hauptfarbe(n),
 "pattern": Muster oder "uni",
 "material": vermutetes Material,
 "formality": Zahl 1 (sehr leger) bis 5 (sehr formell),
 "seasons": Liste aus ["Frühling","Sommer","Herbst","Winter"],
 "description": ein Satz, der das Teil für einen Stylisten genau beschreibt}`;
  return geminiJson([{ text: prompt }, img(image)]);
}

async function suggestOutfit({ occasion, notes, weather, items, person }) {
  if (!items?.length) throw httpError(400, 'Der Kleiderschrank ist leer.');
  const list = items.map(i => ({
    id: i.id, category: i.category, name: i.name, color: i.color, pattern: i.pattern,
    material: i.material, formality: i.formality, seasons: i.seasons, description: i.description,
  }));
  const prompt = `Du bist ein erfahrener persönlicher Stylist. Stelle aus dem Kleiderschrank unten EIN stimmiges Outfit zusammen.

Anlass: ${occasion}
${weather ? `Wetter: ${weather}\n` : ''}${notes ? `Wünsche der Person: ${notes}\n` : ''}${person ? `Über die Person: ${person}\n` : ''}
Regeln:
- Nutze NUR Teile aus der Liste (per id).
- Ein vollständiges Outfit: Oberkörper + Unterkörper (oder ein Kleid/Anzug), dazu wenn sinnvoll Jacke, Schuhe, Accessoires.
- Achte auf Formalität des Anlasses, Farbharmonie und Wetter.
- Wenn etwas Wichtiges fehlt, sag es in "missing".

Kleiderschrank:
${JSON.stringify(list)}

Antworte NUR mit JSON:
{"title": kurzer Name des Looks,
 "itemIds": [ids der gewählten Teile],
 "reasoning": 2-3 Sätze, warum das Outfit zum Anlass passt,
 "tips": [1-3 kurze Styling-Tipps],
 "missing": Text oder null}`;
  const result = await geminiJson([{ text: prompt }]);
  const valid = new Set(items.map(i => i.id));
  result.itemIds = (result.itemIds || []).filter(id => valid.has(id));
  if (!result.itemIds.length) throw httpError(502, 'Gemini hat keine passenden Teile ausgewählt. Bitte nochmal versuchen.');
  return result;
}

async function tryOn({ portrait, items, occasion }) {
  if (!portrait?.data) throw httpError(400, 'Bitte zuerst ein Porträt hochladen.');
  if (!items?.length) throw httpError(400, 'Kein Outfit ausgewählt.');
  const parts = [
    { text: 'Bild 1 ist ein Foto der Person. Die folgenden Bilder sind einzelne Kleidungsstücke:' },
    img(portrait),
  ];
  items.forEach((it, n) => {
    parts.push({ text: `Kleidungsstück ${n + 1}: ${it.name || it.category} – ${it.description || ''}` });
    parts.push(img(it.image));
  });
  parts.push({
    text: `Erzeuge ein fotorealistisches Ganzkörperfoto genau DIESER Person (gleiches Gesicht, gleiche Frisur, gleiche Hautfarbe, gleiche Statur), die genau diese Kleidungsstücke trägt.
Übernimm Farben, Muster, Schnitt und Details der Kleidungsstücke exakt. Erfinde keine zusätzlichen Kleidungsstücke, außer neutrale Schuhe falls keine dabei sind.
Natürliche, aufrechte Pose, freundlicher Gesichtsausdruck, schlichter heller Hintergrund passend zum Anlass "${occasion}", weiches Licht, Hochformat.`,
  });
  const out = await gemini(IMAGE_MODEL, parts, {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '3:4' },
  });
  const imagePart = out.find(p => p.inlineData || p.inline_data);
  if (!imagePart) {
    const text = out.map(p => p.text || '').join(' ').trim();
    throw httpError(502, `Gemini hat kein Bild erzeugt.${text ? ' Antwort: ' + text : ''}`);
  }
  const d = imagePart.inlineData || imagePart.inline_data;
  return { image: { mime: d.mimeType || d.mime_type || 'image/png', data: d.data } };
}

// --- HTTP-Server ---------------------------------------------------------------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Anfrage zu groß.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(httpError(400, 'Ungültiges JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const routes = { '/api/tag': tagItem, '/api/suggest': suggestOutfit, '/api/tryon': tryOn };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { hasKey: Boolean(API_KEY), textModel: TEXT_MODEL, imageModel: IMAGE_MODEL });
    }
    if (req.method === 'POST' && routes[url.pathname]) {
      const body = await readBody(req);
      return send(res, 200, await routes[url.pathname](body));
    }
    send(res, 404, { error: 'Nicht gefunden' });
  } catch (e) {
    console.error(`[${url.pathname}]`, e.message);
    send(res, e.status || 500, { error: e.message || 'Unbekannter Fehler' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Ankleide läuft auf  http://localhost:${PORT}\n`);
  console.log(`  Textmodell:  ${TEXT_MODEL}`);
  console.log(`  Bildmodell:  ${IMAGE_MODEL}`);
  if (!API_KEY) console.log('\n  ⚠  Kein GEMINI_API_KEY gefunden. Lege eine Datei .env an (siehe .env.example).\n');
});
