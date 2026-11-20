// Sprach-Eingabe: aufnehmen, an Gemini schicken, Vorschau zeigen, auf die Listen verteilen.
// Wird auf der Startseite und auf der To-do-Seite benutzt.
const LISTS = { einkauf: '🛒 Einkauf', putzen: '🧽 Putzen', pflanzen: '🪴 Pflanzen', todo: '✅ To-do' };
const ORDER = ['einkauf', 'putzen', 'pflanzen', 'todo'];
const plantNames = () => load('hh-pflanzen', []).map(p => p.name);
const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
let preview = null; // {transcript, items: [...]}

// ---------- Aufnahme ----------
let rec = null, stream = null, chunks = [], t0 = 0, tick = null, mode = 'new';
const MAX_SEC = 120;
function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}
function setMicUi(state) {
  const mic = $('#mic');
  mic.classList.toggle('rec', state === 'rec');
  mic.disabled = state === 'busy';
  mic.textContent = state === 'rec' ? '⏹' : state === 'busy' ? '⏳' : '🎙️';
  mic.setAttribute('aria-label', state === 'rec' ? 'Aufnahme beenden' : 'Aufnahme starten');
  $('#micLabel').innerHTML = state === 'rec' ? `<b>Ich höre zu …</b> ${mode === 'fix' ? '(Änderung)' : ''}` : state === 'busy' ? '<b>Sortiere …</b>' : '<b>Tippen und lossprechen</b>';
  if (state !== 'rec') { clearInterval(tick); $('#timer').textContent = ''; }
}
function stopTracks() { try { stream?.getTracks().forEach(t => t.stop()); } catch {} stream = null; }

async function startRec(m = 'new') {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return showMsg('Dein Browser kann hier nicht aufnehmen. Nutze „Lieber tippen?“.', 'warn');
  mode = m;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return showMsg(e.name === 'NotAllowedError' ? 'Bitte erlaube den Zugriff aufs Mikrofon. Auf dem iPhone fragt die App das bei jedem Start neu.' : 'Mikrofon konnte nicht gestartet werden.', 'warn'); }
  const mime = pickMime();
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch { rec = new MediaRecorder(stream); }
  chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = onRecorded;
  rec.start(1000);
  t0 = Date.now(); setMicUi('rec');
  tick = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    $('#timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= MAX_SEC) stopRec();
  }, 250);
}
function stopRec() { if (rec && rec.state !== 'inactive') rec.stop(); }

async function onRecorded() {
  const type = (rec.mimeType || chunks[0]?.type || 'audio/mp4').split(';')[0];
  const blob = new Blob(chunks, { type }); stopTracks(); rec = null;
  if (Date.now() - t0 < 800 || blob.size < 1000) { setMicUi('idle'); return showMsg('Die Aufnahme war zu kurz. Halte nichts gedrückt: einmal tippen, sprechen, nochmal tippen.', 'warn'); }
  const data = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(blob); });
  await process({ audio: { mime: type, data } });
}

$('#mic').onclick = () => { if (rec && rec.state === 'recording') stopRec(); else startRec('new'); };
$('#fixBtn').onclick = () => { if (rec && rec.state === 'recording') stopRec(); else { startRec('fix'); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
$('#typedBtn').onclick = () => { const t = $('#typed').value.trim(); if (t) { mode = preview ? mode : 'new'; process({ text: t }); } };

// ---------- Gemini ----------
// iPhone nimmt meist audio/mp4 auf. Gemini nennt offiziell m4a/aac, deshalb probieren wir nacheinander.
function audioMimes(m) {
  if (/mp4|m4a|aac/.test(m)) return [m === 'audio/aac' ? 'audio/aac' : 'audio/mp4', 'audio/m4a', 'audio/aac'];
  if (/webm/.test(m)) return ['audio/webm', 'audio/ogg'];
  return [m || 'audio/mp4', 'audio/m4a'];
}
function contextText() {
  const d = new Date();
  const shop = load(LIST_KEY, []).filter(i => !i.done).map(i => i.text);
  return `Heute ist ${WD[d.getDay()]}, der ${isoDay(d)} (Zeitzone Europe/Berlin).
Ziele: "einkauf" (etwas kaufen/besorgen), "putzen" (Reinigen, Aufräumen, Wäsche, Haushaltspflege), "pflanzen" (gießen, düngen, umtopfen, schneiden, Pflanzen kaufen ausgenommen – das ist Einkauf), "todo" (alles andere: anrufen, Termine, Erledigungen, Reparaturen).
Pflanzen im Flora-Park: ${plantNames().join(', ') || '(keine)'}.
Einkauf-Gänge (nur diese): ${AISLES.join(', ')}.
Räume (nur diese): ${ROOMS.join(', ')}.
Schon auf der Einkaufsliste: ${shop.length ? shop.join(', ') : '(leer)'}.`;
}
const FORMAT = `Antworte NUR mit JSON:
{"transcript": "wörtliche Mitschrift (bei Text-Eingabe den Text)",
 "items": [{"title": "kurz und klar, deutsch, ohne Datum im Titel", "list": "einkauf|putzen|pflanzen|todo", "plant": "Name aus dem Flora-Park oder null", "watered": true wenn gesagt wird, dass eine Pflanze SCHON gegossen wurde, sonst false,
   "quantity": "Menge oder null", "aisle": "Gang oder null", "room": "Raum oder null",
   "due": "YYYY-MM-DD oder null", "time": "HH:MM oder null", "priority": "hoch|mittel|niedrig",
   "dupe": true wenn es schon auf der Einkaufsliste steht, sonst false}]}
Regeln: Jeder gesagte Punkt ein eigener Eintrag. Korrekturen beim Sprechen ("ähm, nee, doch Donnerstag") berücksichtigen. "morgen", "Samstag", "übernächste Woche" in echte Daten umrechnen (nächstes Vorkommen ab heute). Nichts erfinden.`;

async function process(input) {
  setMicUi('busy');
  try {
    let prompt;
    if (mode === 'fix' && preview) {
      prompt = `Du verwaltest eine Vorschau von Haushalts-Einträgen. Die Person ${input.audio ? 'sagt in der Aufnahme' : 'schreibt'}, was geändert werden soll (hinzufügen, ändern, löschen, verschieben).
${contextText()}
Aktuelle Vorschau (JSON): ${JSON.stringify(preview.items.map(({ title, list, quantity, aisle, room, due, time, priority, dupe, plant, watered }) => ({ title, list, quantity, aisle, room, due, time, priority, dupe, plant, watered })))}
${input.text ? 'Änderungswunsch: ' + input.text + '\n' : ''}Gib die KOMPLETTE neue Liste zurück. ${FORMAT}`;
    } else {
      prompt = `Du bist ein Haushalts-Assistent. ${input.audio ? 'Schreib die Sprachaufnahme mit und sortiere' : 'Sortiere'} alles Gesagte in einzelne Einträge.
${contextText()}
${input.text ? 'Text: ' + input.text + '\n' : ''}${FORMAT}`;
    }
    let r, lastErr;
    const mimes = input.audio ? audioMimes(input.audio.mime) : [null];
    for (const mime of mimes) {
      try {
        r = await geminiJson(prompt, mime ? [{ mime, data: input.audio.data }] : []);
        break;
      } catch (e) {
        lastErr = e;
        if (!(e.raw && e.raw.startsWith('400'))) throw e; // nur bei Formatfehler nächstes Format probieren
      }
    }
    if (!r) throw lastErr;
    const items = (r.items || []).filter(i => i && i.title).map(i => ({
      id: crypto.randomUUID(), title: String(i.title), list: LISTS[i.list] ? i.list : 'todo',
      quantity: i.quantity || '', aisle: AISLES.includes(i.aisle) ? i.aisle : (i.list === 'einkauf' ? 'Sonstiges' : ''),
      room: ROOMS.includes(i.room) ? i.room : '', due: /^\d{4}-\d{2}-\d{2}$/.test(i.due || '') ? i.due : '',
      time: /^\d{2}:\d{2}$/.test(i.time || '') ? i.time : '', priority: ['hoch', 'mittel', 'niedrig'].includes(i.priority) ? i.priority : 'mittel',
      dupe: !!i.dupe, plant: plantNames().find(n => n.toLowerCase() === String(i.plant || '').toLowerCase()) || '', watered: !!i.watered }));
    // Duplikate auf der Einkaufsliste selbst nochmal prüfen
    const shop = new Set(load(LIST_KEY, []).filter(i => !i.done).map(i => i.text.toLowerCase().replace(/\s*\(.*\)$/, '')));
    items.forEach(i => { if (i.list === 'einkauf' && shop.has(i.title.toLowerCase())) i.dupe = true; });
    if (!items.length) throw new Error('Ich habe keine Aufgaben herausgehört. Versuch es nochmal etwas lauter oder tippe den Text.');
    preview = { transcript: r.transcript || input.text || '', items };
    mode = 'new'; $('#typed').value = '';
    renderPreview();
  } catch (e) { showMsg(e.message); }
  setMicUi('idle');
}

// ---------- Vorschau ----------
function renderPreview() {
  const box = $('#preview'); box.hidden = !preview;
  if (!preview) return;
  $('#transcript').textContent = preview.transcript ? `„${preview.transcript}“` : '';
  $('#cards').innerHTML = ORDER.map(l => {
    const its = preview.items.filter(i => i.list === l); if (!its.length) return '';
    return `<div class="group"><h3>${LISTS[l]}</h3>${its.map(cardHtml).join('')}</div>`;
  }).join('');
  $('#cards').querySelectorAll('[data-k]').forEach(el => el.oninput = el.onchange = () => {
    const it = preview.items.find(i => i.id === el.dataset.id); it[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; if (el.type === 'checkbox') renderPreview();
  });
  $('#cards').querySelectorAll('[data-list]').forEach(b => b.onclick = () => {
    const it = preview.items.find(i => i.id === b.dataset.id); it.list = b.dataset.list;
    if (it.list === 'einkauf' && !it.aisle) it.aisle = 'Sonstiges';
    renderPreview();
  });
  $('#cards').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    preview.items = preview.items.filter(i => i.id !== b.dataset.rm); if (!preview.items.length) preview = null; renderPreview();
  });
  $('#cards').querySelectorAll('[data-keep]').forEach(b => b.onclick = () => { preview.items.find(i => i.id === b.dataset.keep).dupe = false; renderPreview(); });
  $('#applyBtn').textContent = `✓ ${preview.items.filter(i => !i.dupe).length} übernehmen`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cardHtml(i) {
  const sw = ORDER.map(l => `<button class="chip" data-id="${i.id}" data-list="${l}" aria-pressed="${i.list === l}">${LISTS[l]}</button>`).join('');
  const extra = i.list === 'einkauf'
    ? `<input type="text" data-id="${i.id}" data-k="quantity" value="${esc(i.quantity)}" placeholder="Menge" style="width:90px;padding:5px 8px;font-size:13px">
       <select data-id="${i.id}" data-k="aisle">${AISLES.map(a => `<option ${a === i.aisle ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>`
    : i.list === 'pflanzen'
    ? `<select data-id="${i.id}" data-k="plant"><option value="">Pflanze …</option>${plantNames().map(n => `<option ${n === i.plant ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
       <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink)"><input type="checkbox" data-id="${i.id}" data-k="watered" ${i.watered ? 'checked' : ''}> schon gegossen</label>
       ${i.watered ? '' : `<input type="date" data-id="${i.id}" data-k="due" value="${esc(i.due)}" aria-label="Datum">`}`
    : `${i.list === 'putzen' ? `<select data-id="${i.id}" data-k="room"><option value="">Raum …</option>${ROOMS.map(r => `<option ${r === i.room ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}
       <input type="date" data-id="${i.id}" data-k="due" value="${esc(i.due)}" aria-label="Datum">
       ${i.list === 'todo' ? `<input type="time" data-id="${i.id}" data-k="time" value="${esc(i.time)}" aria-label="Uhrzeit" style="width:auto;padding:5px 8px;font-size:13px">` : ''}`;
  return `<div class="pcard ${i.dupe ? 'dupe' : ''}">
    <div class="top"><input class="title" type="text" data-id="${i.id}" data-k="title" value="${esc(i.title)}" aria-label="Titel">
      <button class="x" data-rm="${i.id}" aria-label="Verwerfen">×</button></div>
    ${i.dupe ? `<div class="opts"><span class="tag">steht schon auf der Einkaufsliste</span><button class="chip" data-keep="${i.id}">trotzdem hinzufügen</button></div>` : ''}
    <div class="opts">${sw}</div>
    <div class="opts">${extra}</div></div>`;
}
$('#discardBtn').onclick = () => { preview = null; renderPreview(); };
$('#applyBtn').onclick = () => {
  const items = preview.items.filter(i => !i.dupe);
  const shop = items.filter(i => i.list === 'einkauf').map(i => ({ text: i.quantity ? `${i.title} (${i.quantity})` : i.title, group: i.aisle, source: '' }));
  const nShop = addToShoppingList(shop, '');
  const todos = load(TODO_KEY, []), clean = load(CLEAN_KEY, []);
  const now = Date.now();
  items.filter(i => i.list === 'todo').forEach(i => todos.push({ id: i.id, title: i.title, due: i.due, time: i.time, priority: i.priority, done: false, updatedAt: now }));
  // Pflanzen: "schon gegossen" setzt den Gießplan zurück, alles andere wird eine Pflanzen-Aufgabe in den To-dos
  const plants = load('hh-pflanzen', []); let nW = 0;
  items.filter(i => i.list === 'pflanzen').forEach(i => {
    const pl = plants.find(p => p.name === i.plant);
    if (i.watered && pl) { pl.last = isoDay(); pl.updatedAt = now; nW++; }
    else todos.push({ id: i.id, title: i.title, due: i.due, time: i.time, priority: i.priority, done: false, kind: 'pflanzen', plant: i.plant, updatedAt: now });
  });
  save('hh-pflanzen', plants);
  items.filter(i => i.list === 'putzen').forEach(i => clean.push({ id: i.id, title: i.title, room: i.room, due: i.due, done: false, updatedAt: now }));
  save(TODO_KEY, todos); save(CLEAN_KEY, clean);
  const nT = items.filter(i => i.list === 'todo' || (i.list === 'pflanzen' && !(i.watered && i.plant))).length, nC = items.filter(i => i.list === 'putzen').length;
  preview = null; renderPreview();
  showMsg(`Übernommen: ${nShop} Einkauf, ${nC} Putzen, ${nT} To-do${nW ? `, ${nW} Pflanze${nW > 1 ? 'n' : ''} als gegossen markiert` : ''}.`, 'ok', 5000);
  window.onVoiceApplied?.({ nShop, nC, nT });
};

