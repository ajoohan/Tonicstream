// 페이지(및 iframe) 안의 <video> 요소를 찾아 목록을 알려주고,
// 요청 시 재생 화면을 그대로 녹화해 MP4로 저장한다.
// DRM(넷플릭스 등 유료 OTT)으로 보호된 영상은 브라우저가 녹화를 막아 검은 화면만 저장된다.

// 이미 들어가 있고 살아 있으면 다시 넣지 않는다. 확장이 업데이트·새로 고침되면 이전 것은 죽은 상태가 되므로
// (메시지를 못 받음) 그때는 새로 넣는다.
// (이 파일은 같은 페이지에 여러 번 주입될 수 있어서 맨 바깥에는 const/let 선언을 두지 않는다)
if (!(() => { try { return typeof window.__tonicstream === 'function' && window.__tonicstream(); } catch { return false; } })()) {
  const __rt = chrome.runtime;
  // 이 사본이 살아 있는지. 새로 주입된 사본이 window.__tonicstream을 덮어써도, 죽은 옛 사본은 자기 것으로 판단해 멈춘다.
  const alive = () => { try { return !!__rt.id && !!__rt.getURL(''); } catch { return false; } };
  window.__tonicstream = alive;

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

  // 예비 저장(링크 클릭)용 이름. 평소 이름은 배경(background)의 naming.js가 만든다. 규칙은 그쪽과 같게 유지.
  const safeName = s => [...String(s || '').replace(/[\\/:*?"<>|~\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '')].slice(0, 80).join('') || 'video';

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
          visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
          width: v.videoWidth,
          height: v.videoHeight,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          area: Math.round(r.width * r.height),
          playing: !v.paused,
          time: v.currentTime || 0,
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

  // 페이지 위쪽에 잠깐 떴다 사라지는 안내
  function toast(text) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(92vw,560px)';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'padding:11px 16px;border-radius:12px;background:rgba(24,24,28,.94);color:#f0f0f4;border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.35);font:600 14px/1.45 "Pretendard Variable",Pretendard,system-ui,"Segoe UI","Malgun Gothic",sans-serif;word-break:keep-all';
    box.textContent = text;
    root.appendChild(box);
    (document.body || document.documentElement).appendChild(host);
    setTimeout(() => host.remove(), 7000);
  }

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
    tell({ type: 'videorec-state', recording: recs.size > 0 });
  }

  // 보관함에 넣을 작은 미리보기 그림. 다른 도메인 영상처럼 꺼낼 수 없으면 빈 값.
  function thumbOf(v) {
    try {
      if (!v?.videoWidth) return '';
      const k = Math.min(1, 240 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    } catch { return ''; }
  }

  // range: { from, to } 초 단위. 주어지면 그 구간만 녹화한다.
  const starting = new Set(); // 시작 준비 중(되감기·재생 대기)인 영상
  // 확장이 업데이트·재시작되면 sendMessage가 바로 오류를 던진다. 그래도 녹화 저장은 이어지도록 감싼다.
  function tell(msg) {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); }
  }
  // 페이지를 떠나면 녹화도 끝나므로 툴바 아이콘 상태를 되돌린다
  addEventListener('pagehide', () => { if (recs.size) tell({ type: 'videorec-state', recording: false }); });

  // 저장 설정(화질, 저장 버튼 표시)을 읽어 두고 바뀌면 따라간다. 값의 뜻은 naming.js 참고.
  const BITS = { high: 8_000_000, medium: 4_000_000, small: 1_500_000 };
  let settings = { quality: 'high', hover: 'ads' };
  // 모든 탭·프레임이 저장소 변경 알림을 받지 않도록, 녹화를 시작할 때와 마우스를 올릴 때만(최대 5초에 한 번) 읽는다.
  let settingsAt = 0;
  const loadSettings = async () => {
    settingsAt = Date.now();
    try { settings = { ...settings, ...(await chrome.storage.local.get('naming')).naming }; } catch {}
    return settings;
  };
  loadSettings();

  async function startRecording(id, fromStart, title, range) {
    if (recs.has(id) || starting.has(id)) return; // 버튼을 연달아 눌러도 한 번만 시작
    starting.add(id);
    try { await beginRecording(id, fromStart, title, range); } finally { starting.delete(id); }
  }
  async function beginRecording(id, fromStart, title, range) {
    const v = findVideo(id);
    if (!v) throw new Error('영상을 찾을 수 없습니다. 창을 새로고침(↻) 해주세요.');
    if (adShowing()) {
      throw new Error('유튜브 광고가 재생 중입니다. 광고가 끝난 뒤 다시 눌러주세요.');
    }

    const bounded = fromStart || !!range; // 끝이 정해진 녹화: 되감기면 종료
    const startAt = range ? range.from : 0;
    if (bounded && Math.abs(v.currentTime - startAt) > 0.2) {
      v.currentTime = startAt;
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
    await loadSettings(); // 방금 바꾼 화질 설정도 반영
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITS[settings.quality] || BITS.high });
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
    const startTime = v.currentTime;
    let thumb = '';
    const onTime = () => {
      sync();
      if (adShowing()) { last = 0; return; } // 광고 중 시간 이동은 무시
      // 쇼츠/릴스/틱톡은 무한 반복 재생 → 처음으로 되감기면 한 바퀴 끝으로 보고 자동 종료
      if (bounded && v.currentTime < last - 0.5) return stopRecording(id);
      if (range && v.currentTime >= range.to) return stopRecording(id);
      last = v.currentTime;
      if (!thumb && v.currentTime > startTime + 0.5) thumb = thumbOf(v); // 첫 장면이 검은 화면인 경우가 많아 조금 지난 뒤 찍는다
    };
    const onStop = () => stopRecording(id);
    // 영상이 다른 것으로 바뀌면(유튜브 중간 광고 등) 녹화를 이어 갈 수 없어 여기까지 저장한다. 조용히 끊기지 않게 알려 준다.
    const onSwap = () => {
      if (recs.has(id) && !v.ended) toast('영상이 바뀌어 여기까지만 저장했습니다. 긴 영상이나 광고가 있는 영상은 "탭 녹화"를 이용해 보세요.');
      stopRecording(id);
    };
    const handlers = { pause: sync, play: sync, timeupdate: onTime, ended: onStop, emptied: onSwap };
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
      const res = await tell({ type: 'save-blob', url, title: title || document.title, ext,
        kind: range ? '구간 녹화' : '영상 녹화', thumb: thumb || thumbOf(v) });
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
      const res = await tell({ type: 'save-blob', url, title: title || document.title, ext: 'png', suffix,
        kind: '장면 캡처', thumb: thumbOf(v) });
      if (!res?.ok) {
        // 배경이 저장하지 못하면(시크릿 창 등) 페이지에서 직접 저장한다
        const a = Object.assign(document.createElement('a'), { href: url, download: `${safeName(title || document.title)} ${suffix}.png` });
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
      }
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

  // ── 영상 위 "저장" 버튼 ──
  // 광고 라이브러리(Meta · TikTok)처럼 영상이 줄지어 있는 곳에서, 영상에 마우스를 올리면 버튼 하나로 저장한다.
  // 설정(hover)에 따라: ads = 광고 라이브러리에서만, all = 모든 사이트, off = 표시 안 함.
  const isAdLibrary = () => {
    const h = location.hostname, p = location.pathname;
    return (/(^|\.)facebook\.com$/.test(h) && p.startsWith('/ads/library')) || h === 'library.tiktok.com'
      || (h === 'ads.tiktok.com' && p.includes('creativecenter'));
  };
  const hoverOn = () => settings.hover === 'all' || (settings.hover !== 'off' && isAdLibrary());
  let hb = null, hbVideo = null, hbBusy = false, hbLast = 0;

  function hoverButton() {
    if (hb?.isConnected) return hb;
    hb?.remove();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;display:none';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      button{all:unset;cursor:pointer;display:flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;
        background:rgba(24,24,28,.92);color:#fff;border:1px solid rgba(255,255,255,.18);box-shadow:0 6px 18px rgba(0,0,0,.4);
        font:700 13px/1.2 "Pretendard Variable",Pretendard,system-ui,"Segoe UI","Malgun Gothic",sans-serif;white-space:nowrap}
      button:hover{background:#e5484d;border-color:#e5484d}
      i{width:9px;height:9px;border-radius:50%;background:#ff5a5f;display:inline-block}
      button:hover i{background:#fff}
    </style><button><i></i><span>저장</span></button>`;
    const label = root.querySelector('span');
    root.querySelector('button').addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const v = hbVideo;
      if (!v || hbBusy) return;
      hbBusy = true;
      label.textContent = '저장 중…';
      const done = await saveFromPage(v).catch(err => ({ ok: false, error: err.message }));
      label.textContent = done.ok ? done.text : `실패: ${done.error || ''}`.slice(0, 40);
      setTimeout(() => { label.textContent = '저장'; hbBusy = false; }, 2200);
    });
    (document.body || document.documentElement).appendChild(host);
    return (hb = host);
  }

  // 원본 파일을 바로 받을 수 있으면 받고, 아니면 처음부터 끝까지 녹화한다
  async function saveFromPage(v) {
    const src = /^https?:/.test(v.currentSrc) ? v.currentSrc : '';
    const cross = src && new URL(src).origin !== location.origin && !v.crossOrigin;
    if (src && (cross || /\.(mp4|webm|mov)$/i.test(new URL(src).pathname))) { // 주소 뒤의 ?… #… 는 빼고 판단
      const res = await tell({ type: 'save-video-url', url: src, title: document.title, thumb: thumbOf(v) });
      if (res?.ok) return { ok: true, text: '저장했습니다' };
      if (cross) return { ok: false, error: res?.error || '받기 실패' };
    }
    await startRecording(idOf(v), Number.isFinite(v.duration), document.title);
    return { ok: true, text: '녹화 시작' };
  }

  // 버튼이 화면에 남아 탭 녹화나 장면 캡처에 찍히지 않도록, 마우스가 멈춘 지 2.5초가 지나거나
  // 페이지 밖으로 나가거나 창이 뒤로 가면(팝업을 열 때 포함) 숨긴다.
  let hbHideTimer = null;
  const hideHover = () => { if (hb && !hbBusy) hb.style.display = 'none'; };
  document.documentElement.addEventListener('mouseleave', hideHover);
  addEventListener('blur', hideHover);
  addEventListener('mousemove', e => {
    if (e.timeStamp - hbLast < 150) return;
    hbLast = e.timeStamp;
    if (!alive()) return hideHover(); // 확장이 새로 고쳐져 이 스크립트가 죽은 상태면 아무것도 하지 않음
    if (Date.now() - settingsAt > 5000) loadSettings();
    clearTimeout(hbHideTimer);
    hbHideTimer = setTimeout(hideHover, 2500);
    if (!hoverOn()) { if (hb) hb.style.display = 'none'; return; }
    // 영상이 다른 요소에 덮여 있는 사이트가 많아, 마우스 아래에 겹쳐 있는 것들 중에서 영상을 찾는다
    const v = document.elementsFromPoint(e.clientX, e.clientY).find(x => x.tagName === 'VIDEO');
    if (!v || v.getBoundingClientRect().width < 160 || !(v.readyState > 0 || v.currentSrc)) {
      if (hb && !hbBusy && !(e.target === hb)) hb.style.display = 'none';
      return;
    }
    const r = v.getBoundingClientRect(), b = hoverButton();
    hbVideo = v;
    b.style.display = 'block';
    b.style.top = `${Math.max(8, r.top + 10)}px`;
    b.style.left = `${Math.max(8, Math.min(innerWidth - 110, r.right - 100))}px`;
  }, { passive: true, capture: true });
  addEventListener('scroll', hideHover, { passive: true, capture: true });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'list') { sendResponse({ videos: list(), title: document.title }); return; }
    if (msg.type === 'record') {
      startRecording(msg.id, msg.fromStart, msg.title, msg.range)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'thumb') { sendResponse({ thumb: thumbOf(findVideo(msg.id)) }); return; }
    if (msg.type === 'snapshot') {
      if (hb) hb.style.display = 'none'; // 캡처에 버튼이 찍히지 않게
      snapshot(msg.id, msg.title).then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'stop') { stopRecording(msg.id); sendResponse({ ok: true }); }
    if (msg.type === 'stop-all') { const n = recs.size; for (const id of [...recs.keys()]) stopRecording(id); sendResponse({ ok: true, stopped: n }); }
  });
}
