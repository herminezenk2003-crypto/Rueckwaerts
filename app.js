// Rückwärts: Ton aufnehmen und rückwärts abspielen. Aufnahmen bleiben nur auf diesem Handy gespeichert.
const $ = (id) => document.getElementById(id);
const recBtn = $('rec'), playBtn = $('play'), timeEl = $('time'), msgEl = $('msg');

let recorder = null, stream = null, chunks = [], startedAt = 0, timer = null;
let audioCtx = null;
let items = [];            // gespeicherte Aufnahmen, neueste zuerst: { id, date, dur, wav }
const urls = new Map();    // id -> Objekt-URL zum Abspielen
const player = new Audio();
let playingId = null;

function msg(text) { msgEl.textContent = text || ''; }
function fmt(sec) { const s = Math.round(sec); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function when(ts) {
  const d = new Date(ts), today = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return 'Heute, ' + time;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: '2-digit' }) + ', ' + time;
}

// ---- Speicher (IndexedDB, bleibt auf dem Handy) ----
let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((ok, fail) => {
    const r = indexedDB.open('rueckwaerts', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('aufnahmen', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return dbPromise;
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const tx = d.transaction('aufnahmen', mode);
    const req = fn(tx.objectStore('aufnahmen'));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => fail(tx.error);
  });
}
const loadAll = () => store('readonly', (s) => s.getAll());
const saveItem = (it) => store('readwrite', (s) => s.put(it));
const deleteItem = (id) => store('readwrite', (s) => s.delete(id));

// ---- Aufnehmen ----
function pickType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { msg('Dieses Handy oder dieser Browser kann leider keine Töne aufnehmen.'); return; }
  stopPlayback();
  // Im Tipp anlegen, sonst blockiert Safari den Ton
  if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; audioCtx = new AC(); }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    msg('Ohne Mikrofon geht es nicht. Bitte den Zugriff aufs Mikrofon erlauben (in den Einstellungen bei Safari bzw. Chrome).');
    return;
  }
  const type = pickType();
  recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start();
  startedAt = Date.now();
  recBtn.classList.add('recording');
  $('recLabel').textContent = 'Stopp';
  playBtn.disabled = true;
  timeEl.textContent = '0:00';
  timer = setInterval(() => { timeEl.textContent = fmt((Date.now() - startedAt) / 1000); }, 250);
  msg('Nimmt auf … Zum Beenden nochmal tippen.');
}

function stopRecording() {
  clearInterval(timer);
  recBtn.classList.remove('recording');
  $('recLabel').textContent = 'Aufnehmen';
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function finishRecording() {
  const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || '' });
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; recorder = null;
  if (!blob.size) { msg('Die Aufnahme war leer. Bitte nochmal versuchen.'); render(); return; }
  msg('Einen Moment …');
  let buf;
  try {
    const data = await blob.arrayBuffer();
    buf = await new Promise((ok, fail) => {
      const p = audioCtx.decodeAudioData(data, ok, fail);
      if (p && p.then) p.then(ok, fail);
    });
  } catch (e) {
    msg('Die Aufnahme konnte nicht umgedreht werden. Bitte nochmal versuchen.');
    render();
    return;
  }
  const it = { id: Date.now(), date: Date.now(), dur: buf.duration, wav: reversedWav(buf) };
  items.unshift(it);
  try { await saveItem(it); msg('Gespeichert! Jetzt rückwärts abspielen.'); }
  catch (e) { msg('Fertig! (Speichern hat nicht geklappt, die Aufnahme ist nach dem Schließen weg.)'); }
  render();
}

// Ton umdrehen und als WAV verpacken
// (ein normales Audio-Element spielt auf dem iPhone auch, wenn der Lautlos-Schalter an ist)
function reversedWav(buf) {
  const n = buf.length, ch = buf.numberOfChannels, rate = buf.sampleRate;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
  mono.reverse();
  const wav = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); wav.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
  wav.setUint32(24, rate, true); wav.setUint32(28, rate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
  str(36, 'data'); wav.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, mono[i])); wav.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([wav], { type: 'audio/wav' });
}

// ---- Abspielen ----
function urlFor(it) {
  if (!urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.wav));
  return urls.get(it.id);
}

function play(it) {
  if (playingId === it.id && !player.paused) { stopPlayback(); return; }
  if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
  player.src = urlFor(it);
  player.currentTime = 0;
  playingId = it.id;
  render();
  player.play().catch(() => { playingId = null; render(); msg('Abspielen hat nicht geklappt. Bitte nochmal tippen.'); });
}

function stopPlayback() {
  if (!player.paused) player.pause();
  playingId = null;
  render();
}
player.onended = () => { playingId = null; render(); };

async function remove(it) {
  if (!confirm('Diese Aufnahme löschen?')) return;
  if (playingId === it.id) stopPlayback();
  try { await deleteItem(it.id); } catch (e) {}
  if (urls.has(it.id)) { URL.revokeObjectURL(urls.get(it.id)); urls.delete(it.id); }
  items = items.filter((x) => x.id !== it.id);
  render();
}

// ---- Anzeige ----
function render() {
  const newest = items[0];
  const recording = !!recorder;
  playBtn.disabled = !newest || recording;
  const bigPlaying = newest && playingId === newest.id;
  playBtn.classList.toggle('playing', !!bigPlaying);
  $('playLabel').textContent = bigPlaying ? 'Stopp' : 'Rückwärts abspielen';
  if (!recording) timeEl.innerHTML = newest ? fmt(newest.dur) : '&nbsp;';

  $('list').hidden = items.length === 0;
  const ul = $('items');
  ul.textContent = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'item';
    const pl = document.createElement('button');
    pl.type = 'button';
    pl.className = 'round pl' + (playingId === it.id ? ' playing' : '');
    pl.setAttribute('aria-label', 'Rückwärts abspielen');
    pl.innerHTML = '<span class="tri"></span>';
    pl.onclick = () => play(it);
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = '<div class="when"></div><div class="len"></div>';
    info.firstChild.textContent = when(it.date);
    info.lastChild.textContent = fmt(it.dur);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'round del';
    del.setAttribute('aria-label', 'Löschen');
    del.textContent = '✕';
    del.onclick = () => remove(it);
    li.append(pl, info, del);
    ul.append(li);
  }
}

recBtn.addEventListener('click', () => { if (recorder) stopRecording(); else startRecording(); });
playBtn.addEventListener('click', () => { if (items[0]) play(items[0]); });

loadAll().then((all) => {
  items = (all || []).sort((a, b) => b.date - a.date);
  render();
}).catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
