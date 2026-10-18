// HI Drive: tap-to-talk voice client. Mic -> /app/voice/turn -> spoken answer.
// Honest limits: mic only works while this page is open and the screen is on;
// Bluetooth car routing depends on the phone and browser treating us as media.
(() => {
  const talkBtn = document.getElementById('talk');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const csrf = document.body.dataset.csrf;
  let conversationId = null, recorder = null, chunks = [], busy = false, speaking = false;

  const setStatus = (t) => { statusEl.textContent = t; };
  const pickMime = () => {
    const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return (window.MediaRecorder && c.find((m) => MediaRecorder.isTypeSupported(m))) || '';
  };
  const addLog = (who, text) => {
    const d = document.createElement('div');
    d.className = 'turn ' + who;
    d.textContent = (who === 'me' ? 'You: ' : 'HI: ') + text;
    logEl.prepend(d);
  };
  function stopSpeech() { try { speechSynthesis.cancel(); } catch {} speaking = false; }
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') { recorder.stop(); recorder.stream.getTracks().forEach((t) => t.stop()); }
    talkBtn.classList.remove('rec');
  }
  async function start() {
    if (busy) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const m = pickMime();
      if (!m) { setStatus('This browser cannot record audio. Use Chrome on Android or Safari on iPhone.'); return; }
      recorder = new MediaRecorder(stream, { mimeType: m });
      chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = send;
      recorder.start();
      stopSpeech();
      setStatus('Listening... tap again to send.');
      talkBtn.classList.add('rec');
    } catch { setStatus('Microphone permission is needed. Allow it and try again.'); }
  }
  function speakClient(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    speaking = true;
    u.onend = () => { speaking = false; };
    speechSynthesis.speak(u);
  }
  async function send() {
    if (!chunks.length) { setStatus('Nothing heard. Try again.'); return; }
    busy = true;
    setStatus('Thinking...');
    try {
      const type = recorder.mimeType;
      const blob = new Blob(chunks, { type });
      const res = await fetch('/app/voice/turn?csrf=' + encodeURIComponent(csrf) + (conversationId ? '&c=' + encodeURIComponent(conversationId) : ''), {
        method: 'POST',
        headers: { 'content-type': type },
        body: blob,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setStatus(j.error || 'Something went wrong. Try again.'); busy = false; return; }
      conversationId = j.conversationId || conversationId;
      if (j.transcript) addLog('me', j.transcript);
      if (j.answer) addLog('hi', j.answer);
      setStatus('Tap the button and talk.');
      if (j.audio) {
        const a = new Audio('data:audio/wav;base64,' + j.audio);
        speaking = true;
        a.onended = () => { speaking = false; };
        a.play().catch(() => speakClient(j.answer || ''));
      } else if (j.answer) speakClient(j.answer);
    } catch { setStatus('Network problem. Check your signal and try again.'); }
    busy = false;
  }
  talkBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') stopRecording();
    else if (speaking) stopSpeech();
    else start();
  });
  stopBtn.addEventListener('click', () => { stopSpeech(); stopRecording(); setStatus('Stopped. Tap the button to talk.'); });
  // Due-reminder loop: results of the agent's scheduled tasks surface and are
  // spoken while Drive Mode is open (queued server-side until then).
  async function pollAlerts() {
    try {
      const res = await fetch('/app/voice/alerts?csrf=' + encodeURIComponent(csrf));
      if (!res.ok) return;
      const j = await res.json().catch(() => ({}));
      for (const a of j.alerts || []) {
        addLog('hi', (a.title ? a.title + ': ' : '') + a.text);
        setStatus('Reminder: ' + (a.title || 'task update'));
        speakClient(a.text);
      }
    } catch { /* offline or not signed in: try again next tick */ }
  }
  setInterval(() => { if (!document.hidden && !busy && !speaking) pollAlerts(); }, 25000);
  pollAlerts();
  document.getElementById('newchat').addEventListener('click', (e) => {
    e.preventDefault();
    conversationId = null;
    logEl.innerHTML = '';
    setStatus('New conversation. Tap the button and talk.');
  });
})();
