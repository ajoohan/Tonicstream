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

  // ── 녹화 중 페이지에 띄우는 정지 바 ──
  // 영상 요소만 녹화하므로 이 바는 결과 파일에 찍히지 않는다.
  let bar = null, barTimer = null;
  function showBar() {
    if (bar) return;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .b{display:flex;align-items:center;gap:10px;padding:7px 8px 7px 14px;border-radius:999px;background:rgba(24,24,28,.92);
        color:#f0f0f4;font:600 14px/1.2 "Pretendard Variable",Pretendard,system-ui,"Segoe UI","Malgun Gothic",sans-serif;
        box-shadow:0 8px 24px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);cursor:default;user-select:none}
      .t{color:#ff6b70;font-variant-numeric:tabular-nums;min-width:92px}
      button{all:unset;cursor:pointer;background:#e5484d;color:#fff;font-weight:700;padding:7px 14px;border-radius:999px}
      button:hover{filter:brightness(1.1)}
      .x{background:transparent;color:#a8a8b4;padding:7px 8px;font-weight:600}
    </style><div class="b"><span class="t"></span><button class="s">정지 후 저장</button><button class="x" title="숨기기">✕</button></div>`;
    const t = root.querySelector('.t');
    const tick = () => {
      const r = [...recs.values()][0];
      if (r) t.textContent = `● 녹화 중 ${Math.floor((Date.now() - r.startedAt) / 60000)}:${String(Math.floor((Date.now() - r.startedAt) / 1000) % 60).padStart(2, '0')}`;
    };
    root.querySelector('.s').onclick = () => { for (const id of [...recs.keys()]) stopRecording(id); };
    root.querySelector('.x').onclick = () => { host.style.display = 'none'; };
    (document.body || document.documentElement).appendChild(host);
    bar = host; tick(); barTimer = setInterval(tick, 500);
  }
  function hideBar() {
    clearInterval(barTimer); bar?.remove(); bar = null;
  }
  // 배경에 녹화 상태를 알려 툴바 아이콘(REC 배지, 한 번 클릭 정지)을 맞춘다
  function syncState() {
    if (recs.size) showBar(); else hideBar();
    chrome.runtime.sendMessage({ type: 'videorec-state', recording: recs.size > 0 }).catch(() => {});
  }

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
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      recorder.start(1000);
    } catch (e) {
      throw new Error(e.name === 'SecurityError'
        ? '이 영상은 녹화가 차단되어 있습니다. 아래 "탭 녹화"를 이용하세요.'
        : '아직 영상이 준비되지 않았습니다. 영상을 재생한 뒤 다시 눌러주세요.');
    }
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
      syncState();
    };

    recorder.onstop = async () => {
      cleanup();
      if (!chunks.length) return;
      const type = recorder.mimeType || mimeType || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      const filename = `${safeName(title || document.title)}.${ext}`; // 예비 저장용 이름
      // 자동 종료(영상 끝·한 바퀴 재생)는 클릭 없이 저장되므로, 다른 도메인·샌드박스 프레임에서도
      // 막히지 않는 브라우저 다운로드 기능으로 저장한다. 실패하면 링크 클릭으로 한 번 더 시도.
      const res = await chrome.runtime.sendMessage({ type: 'save-blob', url, title: title || document.title, ext }).catch(() => null);
      if (!res?.ok) {
        const a = Object.assign(document.createElement('a'), { href: url, download: filename });
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    };

    sync(); // 자동재생이 막혀 멈춰 있으면 재생될 때까지 대기
    recs.set(id, { recorder, startedAt: Date.now() });
    syncState();
  }

  // 지금 보이는 장면을 원본 해상도 PNG로 저장한다.
  // 다른 도메인 영상은 브라우저가 막으므로, 위치 정보를 돌려줘 탭 화면 캡처로 대신하게 한다.
  async function snapshot(id, title) {
    const v = findVideo(id);
    if (!v || !v.videoWidth) throw new Error('영상을 찾을 수 없습니다. 창을 새로고침(↻) 해주세요.');
    const t = Math.floor(v.currentTime || 0);
    const suffix = `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s`;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('empty')), 'image/png'));
      const url = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const res = await chrome.runtime.sendMessage({ type: 'save-blob', url, title: title || document.title, ext: 'png', suffix });
      if (!res?.ok) throw new Error(res?.error || '저장 실패');
      return { ok: true, width: c.width, height: c.height };
    } catch (e) {
      const r = v.getBoundingClientRect();
      return { ok: false, fallback: true, suffix, vw: innerWidth, top: window === top,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    }
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
    if (msg.type === 'snapshot') {
      snapshot(msg.id, msg.title).then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'stop') { stopRecording(msg.id); sendResponse({ ok: true }); }
    if (msg.type === 'stop-all') { const n = recs.size; for (const id of [...recs.keys()]) stopRecording(id); sendResponse({ ok: true, stopped: n }); }
  });
}
