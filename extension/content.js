// 페이지(및 iframe) 안의 <video> 요소를 찾아 목록을 알려주고,
// 요청 시 재생 화면을 그대로 녹화해 MP4로 저장한다.
// DRM(넷플릭스 등 유료 OTT)으로 보호된 영상은 브라우저가 녹화를 막아 검은 화면만 저장된다.

if (!window.__tonicstream) {
  window.__tonicstream = true;

  const ids = new WeakMap();
  const byId = new Map();
  const recs = new Map(); // id -> { recorder, startedAt, cleanup }
  let nextId = 1;

  const idOf = v => {
    if (!ids.has(v)) { const id = `${nextId++}`; ids.set(v, id); byId.set(id, v); }
    return ids.get(v);
  };

  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const pickMime = () => MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || '';

  const safeName = s => (s || 'video').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 80) || 'video';

  function list() {
    return [...document.querySelectorAll('video')]
      .filter(v => v.readyState > 0 || v.currentSrc)
      .map(v => {
        const r = v.getBoundingClientRect();
        const id = idOf(v);
        const rec = recs.get(id);
        return {
          id,
          width: v.videoWidth,
          height: v.videoHeight,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          area: Math.round(r.width * r.height),
          playing: !v.paused,
          directSrc: /^https?:/.test(v.currentSrc) ? v.currentSrc : null,
          recording: !!rec,
          elapsed: rec ? Math.round((Date.now() - rec.startedAt) / 1000) : 0,
        };
      });
  }

  const once = (el, ev, ms) => new Promise(res => {
    const t = setTimeout(res, ms);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
  });

  async function startRecording(id, fromStart, title) {
    const v = byId.get(id);
    if (!v) throw new Error('영상을 찾을 수 없습니다. 페이지를 새로고침 해주세요.');
    if (recs.has(id)) return;

    if (fromStart && v.currentTime > 0.2) {
      v.currentTime = 0;
      await once(v, 'seeked', 3000);
    }
    await v.play().catch(() => {});

    let stream;
    try {
      stream = v.captureStream();
    } catch (e) {
      throw new Error('이 영상은 녹화가 차단되어 있습니다. (외부 출처/보호된 영상) 위의 "바로 다운로드"를 이용하세요.');
    }

    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);

    const onPause = () => recorder.state === 'recording' && recorder.pause();
    const onPlay = () => recorder.state === 'paused' && recorder.resume();
    let last = v.currentTime;
    // 쇼츠/릴스/틱톡은 무한 반복 재생되므로, 끝에 닿거나 처음으로 되감기면 자동 종료
    const onTime = () => {
      if (!fromStart) return;
      const looped = v.currentTime < last - 0.5;
      const atEnd = Number.isFinite(v.duration) && v.currentTime >= v.duration - 0.25;
      last = v.currentTime;
      if (looped || atEnd) stopRecording(id);
    };
    const onEnded = () => stopRecording(id);
    v.addEventListener('pause', onPause);
    v.addEventListener('play', onPlay);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('ended', onEnded);

    const cleanup = () => {
      v.removeEventListener('pause', onPause);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ended', onEnded);
      recs.delete(id);
    };

    recorder.onstop = () => {
      cleanup();
      if (!chunks.length) return;
      const type = recorder.mimeType || mimeType || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName(title || document.title)}.${ext}`;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };

    recorder.start(1000);
    recs.set(id, { recorder, startedAt: Date.now(), cleanup });
  }

  function stopRecording(id) {
    const rec = recs.get(id);
    if (rec && rec.recorder.state !== 'inactive') rec.recorder.stop();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'list') { sendResponse({ videos: list(), title: document.title }); return; }
    if (msg.type === 'record') {
      startRecording(msg.id, msg.fromStart, msg.title)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'stop') { stopRecording(msg.id); sendResponse({ ok: true }); }
  });
}
