// Gemeinsame Hilfen für alle Bereiche der Haushaltshilfe.
// Einstellungen (Gemini-Schlüssel) teilen sich alle Seiten mit dem Ankleidezimmer.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dataUrl = im => `data:${im.mime};base64,${im.data}`;

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TEXT = 'gemini-3.5-flash';
const FALLBACK_TEXT = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
// Für einfache Erkennung (Pflanze, Zutaten, Kleidung): das schnellste Modell zuerst
const FAST_TEXT = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];
// Modelle, die den Parameter fürs „Nachdenken“ nicht kennen, merken wir uns
const NO_THINK_KEY = 'hh-nothink';
function getCfg() { try { return { textModel: DEFAULT_TEXT, ...JSON.parse(localStorage.getItem('ankleide-cfg') || '{}') }; } catch { return { textModel: DEFAULT_TEXT }; } }
function setCfg(patch) { const c = { ...getCfg(), ...patch }; try { localStorage.setItem('ankleide-cfg', JSON.stringify(c)); } catch {} return c; }

// Mehrere Haushalte: die Listen des gerade gewählten Haushalts liegen unter den normalen Schlüsseln,
// die der anderen unter „hh-store:<id>:<schlüssel>“. Mit withHousehold(id, fn) schreibt man gezielt in einen anderen.
let HH_TARGET = null;
const storeKey = k => HH_TARGET && (SYNC_KEYS.includes(k) || k === DIRTY_KEY) ? `hh-store:${HH_TARGET}:${k}` : k;
function withHousehold(id, fn) {
  const active = (load('hh-household', null) || {}).id;
  if (!id || id === active) return fn();
  HH_TARGET = id; try { return fn(); } finally { HH_TARGET = null; window.hhSync?.flush(id); }
}
function load(key, fallback) { try { const v = JSON.parse(localStorage.getItem(storeKey(key))); return v ?? fallback; } catch { return fallback; } }
// Gemeinsamer Haushalt: diese Listen werden mit der Partnerin geteilt (siehe sync.js)
const SYNC_KEYS = ['hh-einkauf', 'hh-pflanzen', 'hh-todo', 'hh-putzplan', 'hh-rezepte', 'hh-termine'];
const DIRTY_KEY = 'hh-sync-dirty';
function save(key, val) {
  try {
    if (SYNC_KEYS.includes(key) && Array.isArray(val) && localStorage.getItem('hh-household')) markDirty(key, load(key, []), val);
    localStorage.setItem(storeKey(key), JSON.stringify(val));
  } catch {}
  if (SYNC_KEYS.includes(key) && !HH_TARGET) window.hhSync?.flush();
}
// Merkt sich geänderte und gelöschte Einträge, bis sie hochgeladen sind (klappt auch offline)
function markDirty(key, prev, next) {
  const before = new Map(prev.map(i => [i.id, JSON.stringify(i)]));
  const dirty = load(DIRTY_KEY, {}); const d = dirty[key] ||= {};
  for (const it of next) {
    if (!it || !it.id) continue;
    const old = before.get(it.id);
    if (old !== JSON.stringify(it)) {
      if (!old || JSON.parse(old).updatedAt === it.updatedAt) it.updatedAt = Date.now();
      if (!old) { it.createdAt ||= it.updatedAt; it.by ||= localStorage.getItem('hh-uid') || undefined; }
      d[it.id] = 1;
    }
    before.delete(it.id);
  }
  for (const id of before.keys()) d[id] = 'del';
  localStorage.setItem(storeKey(DIRTY_KEY), JSON.stringify(dirty));
}
// Seiten können neu zeichnen, wenn die Partnerin etwas ändert
function onSync(fn) { window.addEventListener('hh-sync', e => fn(e.detail?.key)); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geminiOnce(model, key, parts, generationConfig, think) {
  const noThink = load(NO_THINK_KEY, []);
  const gc = { ...generationConfig };
  // Gemini „denkt“ sonst vor jeder Antwort nach. Für Erkennen und Sortieren reicht wenig davon, das spart viel Zeit.
  if (think && !noThink.includes(model)) gc.thinkingConfig = { thinkingLevel: think };
  let res;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: gc }), signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw Object.assign(new Error('Google hat zu lange gebraucht.'), { next: true });
    throw new Error('Keine Verbindung zu Google. Prüfe dein Internet.');
  }
  clearTimeout(timer);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = data?.error?.message || `Fehler ${res.status}`;
    const e = new Error('Gemini: ' + m);
    e.raw = `${res.status} ${m}`;
    if (res.status === 400 && gc.thinkingConfig && /think/i.test(m)) {
      save(NO_THINK_KEY, [...noThink, model]);
      return geminiOnce(model, key, parts, generationConfig, null);
    }
    if (res.status === 400 && /API key/i.test(m)) { e.message = 'Der Gemini-Schlüssel ist ungültig. Prüfe ihn auf der Startseite unter „Einstellungen“.'; return Promise.reject(e); }
    if (res.status === 404) { e.next = true; e.message = `Das Modell „${model}“ gibt es nicht (mehr).`; }
    if (res.status === 429 || res.status >= 500) { e.next = true; e.retry = true; e.message = 'Google ist gerade überlastet. Bitte in ein paar Minuten nochmal versuchen.'; }
    throw e;
  }
  const out = data?.candidates?.[0]?.content?.parts || [];
  if (!out.length) throw new Error(`Gemini hat nichts zurückgegeben (Grund: ${data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'unbekannt'}).`);
  return out;
}

// Wiederholt bei Überlastung und weicht auf Ersatzmodelle aus.
async function gemini(parts, generationConfig = {}, opts = {}) {
  const cfg = getCfg();
  if (!cfg.key) throw new Error('Trag zuerst auf der Startseite unter „Einstellungen“ deinen Gemini-Schlüssel ein.');
  const first = opts.fast ? FAST_TEXT : [cfg.textModel || DEFAULT_TEXT, ...FALLBACK_TEXT];
  const models = [...new Set(first)];
  const think = opts.think ?? (opts.fast ? 'minimal' : 'low');
  let last;
  for (const m of models) {
    for (let a = 0; a < 2; a++) {
      try { return await geminiOnce(m, cfg.key, parts, generationConfig, think); }
      catch (e) { last = e; if (!e.next) throw e; if (!e.retry || a === 1) break; await sleep(1000); }
    }
  }
  throw last;
}

async function geminiJson(prompt, images = [], opts = {}) {
  const parts = [{ text: prompt }, ...images.map(im => ({ inline_data: { mime_type: im.mime, data: im.data } }))];
  const out = await gemini(parts, { responseMimeType: 'application/json', temperature: 0.7 }, opts);
  const text = out.map(p => p.text || '').join('');
  try { return JSON.parse(text); }
  catch { const m = text.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]); throw new Error('Antwort von Gemini war unverständlich. Bitte nochmal.'); }
}

function shrink(file, max = 1024) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(1, max / Math.max(im.width, im.height));
      const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res({ mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
    };
    im.onerror = () => rej(new Error('Dieses Bild kann ich nicht lesen.'));
    im.src = url;
  });
}

function showMsg(text, kind = 'err', ms = 9000) {
  const box = $('#status'); if (!box) return;
  box.innerHTML = `<div class="banner ${kind}">${esc(text)}</div>`;
  box.scrollIntoView({ block: 'nearest' });
  if (ms) setTimeout(() => { if (box.textContent === text) box.innerHTML = ''; }, ms);
}

function busy(btn, on, label) {
  clearInterval(btn._t);
  if (on) {
    btn.dataset.l = btn.innerHTML; btn.disabled = true; const t0 = Date.now();
    const draw = () => { const s = Math.floor((Date.now() - t0) / 1000); btn.innerHTML = `<span class="spinner"></span> ${label}${s >= 2 ? ` <span style="opacity:.6;font-variant-numeric:tabular-nums">${s} s</span>` : ''}`; };
    draw(); btn._t = setInterval(draw, 1000);
  } else { btn.innerHTML = btn.dataset.l; btn.disabled = false; }
}

// Text-Knoten mit mitlaufenden Sekunden, gibt eine Stopp-Funktion zurück
function tickText(node, label) {
  const t0 = Date.now(); const draw = () => { const s = Math.floor((Date.now() - t0) / 1000); node.textContent = label + (s >= 2 ? ` ${s} s` : ''); };
  draw(); const t = setInterval(draw, 1000); return () => clearInterval(t);
}

function chipGroup(el, options, current, onPick) {
  el.innerHTML = options.map(o => `<button type="button" class="chip" aria-pressed="${o === current}">${esc(o)}</button>`).join('');
  el.querySelectorAll('.chip').forEach(b => b.onclick = () => {
    el.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', x === b));
    onPick(b.textContent);
  });
}

// Einkaufsliste – von Küche und Home Cleaner aus befüllbar
const LIST_KEY = 'hh-einkauf';
function addToShoppingList(names, source) {
  // names: Liste aus Texten oder Objekten {text, group}
  const list = load(LIST_KEY, []);
  const have = new Set(list.filter(i => !i.done).map(i => i.text.toLowerCase()));
  let added = 0;
  for (const n of names) {
    const obj = typeof n === 'object' && n ? n : { text: n };
    const t = String(obj.text || '').trim(); if (!t || have.has(t.toLowerCase())) continue;
    list.push({ id: crypto.randomUUID(), text: t, group: obj.group || '', done: false, source: obj.source ?? source, updatedAt: Date.now() }); have.add(t.toLowerCase()); added++;
  }
  save(LIST_KEY, list);
  return added;
}
const AISLES = ['Obst & Gemüse', 'Brot & Backwaren', 'Kühlregal', 'Fleisch & Fisch', 'Tiefkühl', 'Vorrat & Konserven', 'Gewürze & Backen', 'Getränke', 'Drogerie & Putzmittel', 'Sonstiges'];
const ROOMS = ['Küche', 'Bad', 'Gäste-WC', 'Wohnzimmer', 'Schlafzimmer', 'Kinderzimmer', 'Flur', 'Arbeitszimmer', 'Balkon/Terrasse', 'Keller', 'Auto', 'Sonstiges'];
const TODO_KEY = 'hh-todo', CLEAN_KEY = 'hh-putzplan';
const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function requireKeyBanner() {
  if (!getCfg().key) showMsg('Trag zuerst auf der Startseite unter „Einstellungen“ deinen Gemini-Schlüssel ein.', 'warn', 0);
}

// Aufklappbare Abschnitte: jede Karte mit Überschrift lässt sich per Tipp auf- und zuklappen.
// Die erste ist offen, der Zustand wird pro Seite gemerkt.
function foldSections() {
  let firstDone = false;
  document.querySelectorAll('main > section.card:not([data-nofold])').forEach((sec, i) => {
    const h = sec.querySelector(':scope > h2'); if (!h) return;
    const key = 'hh-fold:' + location.pathname.split('/').pop() + ':' + i;
    sec.classList.add('fold'); h.setAttribute('role', 'button'); h.tabIndex = 0;
    const set = open => { sec.classList.toggle('open', open); h.setAttribute('aria-expanded', open); };
    const def = sec.hasAttribute('data-open') || (!firstDone && !sec.hidden); if (!sec.hidden) firstDone = true;
    set(load(key, def));
    const toggle = () => { const o = !sec.classList.contains('open'); set(o); save(key, o); };
    h.onclick = toggle; h.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}
document.addEventListener('DOMContentLoaded', foldSections);

// Kalender-Datei (.ics) für Aufgaben mit Datum. Antippen öffnet auf dem iPhone „Kalender“ zum Übernehmen.
function icsEsc(s) { s = String(s || ''); if (s.toWellFormed) s = s.toWellFormed(); return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m); }
function tasksIcsUrl(ts) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Haushaltshilfe//Sprach-To-do//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const t of ts) {
    const d = t.due.replace(/-/g, ''), hm = (t.time || '09:00').replace(':', '');
    const [h, m] = (t.time || '09:00').split(':').map(Number); const endM = h * 60 + m + 30;
    const end = `${String(Math.min(23, Math.floor(endM / 60))).padStart(2, '0')}${String(endM >= 24 * 60 ? 59 : endM % 60).padStart(2, '0')}`;
    L.push('BEGIN:VEVENT', `UID:${t.id}@haushaltshilfe`, `DTSTAMP:${stamp}`, `DTSTART:${d}T${hm}00`, `DTEND:${d}T${end}00`,
      `SUMMARY:${icsEsc((t.k === CLEAN_KEY ? '🧽 ' : '') + t.title)}`, ...(t.room ? [`LOCATION:${icsEsc(t.room)}`] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(t.title)}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(L.join('\r\n'));
}

// ---------- Kalender: Termine + alles mit Datum aus den anderen Bereichen ----------
const TERM_KEY = 'hh-termine';
const GEM = 'Gemeinsam';
const myUid = () => (window.hhSync?.household() ? hhSync.myId() : 'me');
const myName = () => localStorage.getItem('hh-me-name') || '';
// Ist dieser Eintrag (Termin/Aufgabe) für mich bzw. für alle?
const isForMe = t => !t.for || t.for === myUid() || (String(t.for).startsWith('name:') && !!myName() && (t.forName || '').toLowerCase() === myName().toLowerCase());
const whoLabel = t => !t.for ? '' : isForMe(t) ? 'du' : (t.forName || '');
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return isoDay(new Date(y, m - 1, d + n)); };
// Alle Einträge zwischen from und to (jeweils YYYY-MM-DD, inklusive), sortiert nach Tag und Uhrzeit
function calendarEntries(from, to) {
  const out = [];
  for (const t of load(TERM_KEY, [])) if (t.date >= from && t.date <= to) out.push({ type: 'termin', date: t.date, time: t.time || '', title: t.title, ref: t });
  for (const t of load(TODO_KEY, [])) if (t.due && !t.done && t.due >= from && t.due <= to) out.push({ type: t.kind === 'pflanzen' ? 'pflanze' : 'todo', date: t.due, time: t.time || '', title: t.title, ref: t });
  for (const t of load(CLEAN_KEY, [])) if (t.due && !t.done && t.due >= from && t.due <= to) out.push({ type: 'putzen', date: t.due, time: '', title: t.title + (t.room ? ' · ' + t.room : ''), ref: t });
  // Gießen: nächster Termin (überfällige zählen heute) und die folgenden im gleichen Rhythmus
  const today = isoDay();
  for (const p of load('hh-pflanzen', [])) {
    if (!p.last) continue;
    let d = p.last, guard = 0;
    const step = () => { const [y, m] = d.split('-').map(Number); const summer = m >= 4 && m <= 9; return Math.max(1, Math.round(summer ? p.summer : p.winter) || 7); };
    d = addDays(d, step());
    if (d < today) d = today;
    while (d <= to && guard++ < 400) { if (d >= from) out.push({ type: 'giessen', date: d, time: '', title: `${p.name} gießen`, ref: p }); d = addDays(d, step()); }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99') || (a.type === 'termin' ? -1 : 1));
}
const CAL_ICON = { termin: '📅', todo: '✅', putzen: '🧽', giessen: '💧', pflanze: '🪴' };
