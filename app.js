// Rückwärts: Ton aufnehmen und rückwärts abspielen. Nichts wird gespeichert oder verschickt.
const $ = (id) => document.getElementById(id);
const recBtn = $('rec'), playBtn = $('play'), timeEl = $('time'), msgEl = $('msg');

let recorder = null, stream = null, chunks = [], startedAt = 0, timer = null;
let audioCtx = null, player = null, playerUrl = null;

function msg(text) { msgEl.textContent = text || ''; }
function fmt(sec) { const s = Math.floor(sec); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

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
  if (!blob.size) { msg('Die Aufnahme war leer. Bitte nochmal versuchen.'); return; }
  msg('Einen Moment …');
  try {
    const data = await blob.arrayBuffer();
    const buf = await new Promise((ok, fail) => {
      const p = audioCtx.decodeAudioData(data, ok, fail);
      if (p && p.then) p.then(ok, fail);
    });
    setReversed(buf);
    timeEl.textContent = fmt(buf.duration);
    playBtn.disabled = false;
    msg('Fertig! Jetzt rückwärts abspielen.');
  } catch (e) {
    msg('Die Aufnahme konnte nicht umgedreht werden. Bitte nochmal versuchen.');
  }
}

// Ton umdrehen und als WAV in ein normales Audio-Element packen
// (das spielt auf dem iPhone auch, wenn der Lautlos-Schalter an ist)
function setReversed(buf) {
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
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  player = new Audio(playerUrl);
  player.onended = () => setPlaying(false);
}

function setPlaying(on) {
  playBtn.classList.toggle('playing', on);
  $('playLabel').textContent = on ? 'Stopp' : 'Rückwärts abspielen';
}

function stopPlayback() {
  if (player && !player.paused) { player.pause(); }
  setPlaying(false);
}

recBtn.addEventListener('click', () => { if (recorder) stopRecording(); else startRecording(); });
playBtn.addEventListener('click', () => {
  if (!player) return;
  if (!player.paused) { stopPlayback(); return; }
  if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
  player.currentTime = 0;
  player.play().then(() => setPlaying(true)).catch(() => msg('Abspielen hat nicht geklappt. Bitte nochmal tippen.'));
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
