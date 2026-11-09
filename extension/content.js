// 페이지(및 iframe) 안의 <video> 요소를 찾아 목록을 알려주고,
// 요청 시 재생 화면을 그대로 녹화해 MP4로 저장한다.
// DRM(넷플릭스 등 유료 OTT)으로 보호된 영상은 브라우저가 녹화를 막아 검은 화면만 저장된다.

if (!window.__tonicstream) {
  window.__tonicstream = true;

  // 피드형 사이트(쇼츠/릴스/틱톡)는 영상 요소가 계속 생기고 사라지므로
  // 요소를 강하게 붙잡지 않도록 WeakMap만 쓰고, 찾을 때는 DOM에서 다시 찾는다.
  const ids = new WeakMap();
  const recs = new Map(); // id -> { recorder, startedAt }
  let nextId = 1;

  const idOf = v => {
    if (!ids.has(v)) ids.set(v, `${nextId++}`);
    return ids.get(v);
  };
  const findVideo = id => [...document.querySelectorAll('video')].find(v => ids.get(v) === id);
  const adShowing = () => !!document.querySelector('#movie_player.ad-showing, .html5-video-player.ad-showing');

  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const pickMime = () => MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || '';

  const safeName = s => (s || 'video').replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'video';

  function list() {
    return [...document.querySelectorAll('video')]
      .filter(v => v.readyState > 0 || v.currentSrc)
      .map(v => {
        const r = v.getBoundingClientRect();
        const id = idOf(v);
        const rec = recs.get(id);
        return {
          id,
          active: !v.paused && r.width > 0 && r.bottom > 0 && r.top < innerHeight,
          width: v.videoWidth,
          height: v.videoHeight,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          area: Math.round(r.width * r.height),
          playing: !v.paused,
          directSrc: /^https?:/.test(v.currentSrc) ? v.currentSrc : null,
          // 다른 도메인에서 직접 불러온 영상(틱톡 등)은 브라우저가 녹화를 막음 → 원본 다운로드로 처리
          crossOrigin: /^https?:/.test(v.currentSrc) && new URL(v.currentSrc).origin !== location.origin && !v.crossOrigin,
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
    const v = findVideo(id);
    if (!v) throw new Error('영상을 찾을 수 없습니다. 창을 새로고침(↻) 해주세요.');
    if (recs.has(id)) return;
    if (adShowing()) {
      throw new Error('유튜브 광고가 재생 중입니다. 광고가 끝난 뒤 다시 눌러주세요.');
    }

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

    recorder.onerror = () => stopRecording(id);

    // 영상이 멈춰 있거나 유튜브 광고가 나오는 동안에는 녹화도 일시정지
    const sync = () => {
      const hold = v.paused || adShowing();
      if (hold && recorder.state === 'recording') recorder.pause();
      if (!hold && recorder.state === 'paused') recorder.resume();
    };
    let last = v.currentTime;
    const onTime = () => {
      sync();
      if (adShowing()) { last = 0; return; } // 광고 중 시간 이동은 무시
      // 쇼츠/릴스/틱톡은 무한 반복 재생 → 처음으로 되감기면 한 바퀴 끝으로 보고 자동 종료
      if (fromStart && v.currentTime < last - 0.5) return stopRecording(id);
      last = v.currentTime;
    };
    const onStop = () => stopRecording(id);
    const handlers = { pause: sync, play: sync, timeupdate: onTime, ended: onStop, emptied: onStop };
    for (const [ev, fn] of Object.entries(handlers)) v.addEventListener(ev, fn);

    const cleanup = () => {
      for (const [ev, fn] of Object.entries(handlers)) v.removeEventListener(ev, fn);
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
    sync(); // 자동재생이 막혀 멈춰 있으면 재생될 때까지 대기
    recs.set(id, { recorder, startedAt: Date.now() });
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
