// Talk control for the main agent page: one app, one conversation.
// The mic button next to the chat box posts a voice turn to the same
// /app/voice/turn endpoint Drive uses, continuing the same conversation.
(() => {
  const box = document.getElementById('talkbox');
  if (!box) return;
  const btn = document.getElementById('talkbtn');
  const statusEl = document.getElementById('talkstatus');
  const thread = document.getElementById('thread');
  const convInput = document.querySelector('input[name="c"]');
  const csrf = box.dataset.csrf;
  let conversationId = box.dataset.c || '';
  let recorder = null, chunks = [], busy = false, speaking = false;

  const setStatus = (t) => { statusEl.textContent = t; };
  const pickMime = () => {
    const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return (window.MediaRecorder && c.find((m) => MediaRecorder.isTypeSupported(m))) || '';
  };
  const addCard = (who, text) => {
    if (!thread) return;
    const d = document.createElement('div');
    d.className = 'msg ' + (who === 'me' ? 'me' : 'hi');
    const head = document.createElement('div');
    head.className = 'who';
    head.textContent = who === 'me' ? 'You (voice)' : 'HI (voice)';
    const body = document.createElement('div');
    body.textContent = text;
    d.append(head, body);
    thread.append(d);
    d.scrollIntoView({ block: 'nearest' });
  };
  function stopSpeech() { try { speechSynthesis.cancel(); } catch {} speaking = false; }
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') { recorder.stop(); recorder.stream.getTracks().forEach((t) => t.stop()); }
    btn.classList.remove('rec');
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
      setStatus('Listening... tap the mic again to send.');
      btn.classList.add('rec');
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
  function adoptConversation(id) {
    if (!id || id === conversationId) return;
    conversationId = id;
    if (convInput) convInput.value = id;
    const url = new URL(location.href);
    url.searchParams.set('c', id);
    history.replaceState(null, '', url);
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
      adoptConversation(j.conversationId);
      if (j.transcript) addCard('me', j.transcript);
      if (j.answer) addCard('hi', j.answer);
      setStatus('');
      if (j.audio) {
        const a = new Audio('data:audio/wav;base64,' + j.audio);
        speaking = true;
        a.onended = () => { speaking = false; };
        a.play().catch(() => speakClient(j.answer || ''));
      } else if (j.answer) speakClient(j.answer);
    } catch { setStatus('Network problem. Check your signal and try again.'); }
    busy = false;
  }
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (recorder && recorder.state === 'recording') stopRecording();
    else if (speaking) stopSpeech();
    else start();
  });
})();
