// Gemeinsame Hilfen für alle Bereiche der Haushaltshilfe.
// Einstellungen (Gemini-Schlüssel) teilen sich alle Seiten mit dem Ankleidezimmer.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dataUrl = im => `data:${im.mime};base64,${im.data}`;

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TEXT = 'gemini-3.5-flash';
const FALLBACK_TEXT = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
function getCfg() { try { return { textModel: DEFAULT_TEXT, ...JSON.parse(localStorage.getItem('ankleide-cfg') || '{}') }; } catch { return { textModel: DEFAULT_TEXT }; } }
function setCfg(patch) { const c = { ...getCfg(), ...patch }; try { localStorage.setItem('ankleide-cfg', JSON.stringify(c)); } catch {} return c; }

function load(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geminiOnce(model, key, parts, generationConfig) {
  let res;
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    });
  } catch { throw new Error('Keine Verbindung zu Google. Prüfe dein Internet.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = data?.error?.message || `Fehler ${res.status}`;
    const e = new Error('Gemini: ' + m);
    e.raw = `${res.status} ${m}`;
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
async function gemini(parts, generationConfig = {}) {
  const cfg = getCfg();
  if (!cfg.key) throw new Error('Trag zuerst auf der Startseite unter „Einstellungen“ deinen Gemini-Schlüssel ein.');
  const models = [cfg.textModel || DEFAULT_TEXT, ...FALLBACK_TEXT.filter(m => m !== cfg.textModel)];
  let last;
  for (const m of models) {
    for (let a = 0; a < 2; a++) {
      try { return await geminiOnce(m, cfg.key, parts, generationConfig); }
      catch (e) { last = e; if (!e.next) throw e; if (!e.retry || a === 1) break; await sleep(2000); }
    }
  }
  throw last;
}

async function geminiJson(prompt, images = []) {
  const parts = [{ text: prompt }, ...images.map(im => ({ inline_data: { mime_type: im.mime, data: im.data } }))];
  const out = await gemini(parts, { responseMimeType: 'application/json', temperature: 0.7 });
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
  if (on) { btn.dataset.l = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span> ${label}`; btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.l; btn.disabled = false; }
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
  const list = load(LIST_KEY, []);
  const have = new Set(list.filter(i => !i.done).map(i => i.text.toLowerCase()));
  let added = 0;
  for (const n of names) {
    const t = String(n).trim(); if (!t || have.has(t.toLowerCase())) continue;
    list.push({ id: crypto.randomUUID(), text: t, done: false, source }); have.add(t.toLowerCase()); added++;
  }
  save(LIST_KEY, list);
  return added;
}

function requireKeyBanner() {
  if (!getCfg().key) showMsg('Trag zuerst auf der Startseite unter „Einstellungen“ deinen Gemini-Schlüssel ein.', 'warn', 0);
}
