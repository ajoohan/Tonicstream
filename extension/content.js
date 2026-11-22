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
  const recs = new Map(); // id -> { recorder, startedAt, heldMs, heldAt, why }
  // 실제로 녹화된 시간(초). 영상이 멈췄거나 버퍼링 중이어서 녹화를 쉬었던 시간은 뺀다.
  const recordedSec = r => Math.max(0, (Date.now() - r.startedAt - r.heldMs - (r.heldAt ? Date.now() - r.heldAt : 0)) / 1000);
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
          // 스트리밍 목록(.m3u8·.mpd)은 영상 파일이 아니라 조각 목록이므로 바로 받기 대상이 아니다
          directSrc: /^https?:/.test(v.currentSrc) && !/\.(m3u8|mpd)(\?|#|$)/i.test(v.currentSrc) ? v.currentSrc : null,
          // 다른 도메인에서 직접 불러온 영상(틱톡 등)은 브라우저가 녹화를 막음 → 원본 다운로드로 처리
          crossOrigin: /^https?:/.test(v.currentSrc) && new URL(v.currentSrc).origin !== location.origin && !v.crossOrigin,
          recording: !!rec,
          elapsed: rec ? Math.round(recordedSec(rec)) : 0,
          hold: rec && rec.heldAt ? rec.why || '대기' : '', // 녹화를 쉬고 있는 이유(버퍼링 등)
        };
      });
  }

  const once = (el, ev, ms) => new Promise(res => {
    const t = setTimeout(res, ms);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
  });

  // ── 페이지 안에서 영상 파일 주소 찾기 ──
  // 네트워크로 지나간 것만 보면 놓치는 경우(아직 재생하지 않은 영상, 확장이 켜지기 전에 불러온 영상)를 보완한다.
  // 여기서는 후보만 모으고, 실제 영상 파일인지는 배경(background)이 서버에 물어 확인한다.
  function scanPage() {
    const EXT = /\.(mp4|m4v|webm|mov|ogv|mkv)$/i;
    const out = new Set();
    const add = (raw, sure) => {
      if (!raw || out.size >= 40) return;
      try {
        const u = new URL(raw, document.baseURI);
        if (/^https?:$/.test(u.protocol) && (sure || EXT.test(u.pathname))) out.add(u.href.split('#')[0]);
      } catch {}
    };
    // 1) 영상 요소와 그 안의 <source> (재생 전이라도 주소는 적혀 있다)
    for (const v of document.querySelectorAll('video')) {
      add(v.currentSrc, true); add(v.getAttribute('src'), true);
      for (const s of v.querySelectorAll('source[src]')) add(s.getAttribute('src'), /^video\//.test(s.type || '') || !s.type);
      for (const a of ['data-src', 'data-video-src', 'data-mp4', 'data-video']) add(v.getAttribute(a));
    }
    // 2) 영상 파일로 가는 링크
    for (const a of [...document.querySelectorAll('a[href]')].slice(0, 400)) add(a.getAttribute('href'));
    // 3) 공유용 정보(og:video 등). 플레이어 페이지 주소인 경우가 많아 영상 형식으로 표시된 것만 믿는다
    const ogType = document.querySelector('meta[property="og:video:type"]')?.content || '';
    for (const m of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')) {
      add(m.content, /^video\//.test(ogType) || m.getAttribute('name') === 'twitter:player:stream');
    }
    // 4) 검색엔진용 정보(JSON-LD)의 영상 주소
    for (const s of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 10)) {
      if (s.textContent.length > 300_000) continue;
      try {
        const walk = o => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) return o.forEach(walk);
          if (/VideoObject/i.test([].concat(o['@type'] || []).join(' '))) add(o.contentUrl, true);
          Object.values(o).forEach(walk);
        };
        walk(JSON.parse(s.textContent));
      } catch {}
    }
    // 5) 이 페이지가 이미 불러온 것들(브라우저가 기록해 둔 목록). 확장이 보기 전에 받은 영상도 여기에 남아 있다
    try {
      // 영상 요소가 불러온 것, 그리고 스크립트가 받아 온 큰 파일(500KB 이상)을 후보로 본다
      for (const e of performance.getEntriesByType('resource')) {
        add(e.name, e.initiatorType === 'video' || (/^(fetch|xmlhttprequest|other)$/.test(e.initiatorType) && e.decodedBodySize > 500_000));
      }
    } catch {}
    return [...out];
  }

  // ── 페이지 전체 캡처 ──
  // 한 화면씩 내려가며 찍어 세로로 이어 붙인다. 상세페이지·랜딩페이지를 한 장으로 저장할 때 쓴다.
  // 화면에 고정된 메뉴(상단 바 등)는 첫 장에만 남기고 그다음부터는 숨겨, 장마다 반복해 찍히지 않게 한다.
  let capturing = false;
  async function capturePage(title) {
    if (capturing) return { ok: false, error: '이미 캡처하는 중입니다.' };
    capturing = true;
    const root = document.scrollingElement || document.documentElement;
    const startY = root.scrollTop;
    const hidden = [];
    const style = document.createElement('style');
    style.textContent = 'html{scroll-behavior:auto!important}::-webkit-scrollbar{display:none!important}';
    document.documentElement.appendChild(style);
    if (bar) bar.style.display = 'none';
    if (hb) hb.style.display = 'none';
    try {
      const vh = innerHeight, vw = innerWidth;
      const full = Math.max(root.scrollHeight, vh);
      const MAX_SHOTS = 40; // 너무 긴 페이지는 여기까지만
      const total = Math.min(full, vh * MAX_SHOTS);
      let canvas = null, ctx = null, scale = 1, shots = 0;
      for (let y = 0; y < total; y += vh) {
        const top = Math.min(y, Math.max(0, full - vh)); // 마지막 장은 바닥에 맞춘다
        root.scrollTop = top;
        await new Promise(r => setTimeout(r, shots ? 650 : 350)); // 늦게 뜨는 그림을 기다리고, 브라우저의 캡처 횟수 제한(초당 2회)도 지킨다
        const res = await tell({ type: 'capture-visible' });
        if (!res?.ok) throw new Error(res?.error || '화면을 찍지 못했습니다.');
        const img = new Image();
        img.src = res.dataUrl;
        await img.decode();
        if (!canvas) {
          scale = img.width / vw;
          // 브라우저가 다룰 수 있는 그림 높이에 한도가 있어, 넘으면 전체를 줄여 담는다
          const k = Math.min(1, 30000 / (total * scale));
          canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * k); canvas.height = Math.round(total * scale * k);
          ctx = canvas.getContext('2d');
          scale *= k;
          ctx.__k = k;
        }
        const drawTop = root.scrollTop; // 실제로 멈춘 위치 (요청한 곳과 다를 수 있다)
        ctx.drawImage(img, 0, Math.round(drawTop * scale), canvas.width, Math.round(img.height * ctx.__k));
        shots++;
        if (shots === 1) {
          for (const e of [...document.querySelectorAll('body *')].slice(0, 6000)) {
            const pos = getComputedStyle(e).position;
            if ((pos === 'fixed' || pos === 'sticky') && e.offsetHeight) { hidden.push([e, e.style.visibility]); e.style.setProperty('visibility', 'hidden', 'important'); }
          }
        }
        if (top + vh >= total) break;
      }
      const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('그림을 만들지 못했습니다.')), 'image/png'));
      const url = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
      // 보관함 미리보기: 맨 위 정사각형 부분
      const t = document.createElement('canvas');
      t.width = 240; t.height = 240;
      t.getContext('2d').drawImage(canvas, 0, 0, canvas.width, Math.min(canvas.height, canvas.width), 0, 0, 240, 240 * Math.min(1, canvas.height / canvas.width));
      const saved = await tell({ type: 'save-blob', url, title: title || document.title, ext: 'png', suffix: '전체', kind: '페이지 캡처', thumb: t.toDataURL('image/jpeg', 0.6) });
      if (!saved?.ok) {
        const a = Object.assign(document.createElement('a'), { href: url, download: `${safeName(title || document.title)} 전체.png` });
        document.documentElement.appendChild(a); a.click(); a.remove();
      }
      return { ok: true, width: canvas.width, height: canvas.height, shots, cut: full > total };
    } finally {
      for (const [e, v] of hidden) { e.style.visibility = v; }
      style.remove();
      root.scrollTop = startY;
      capturing = false;
      tell({ type: 'capture-end' });
    }
  }

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
      .t{color:#ff6b70;font-variant-numeric:tabular-nums;min-width:92px;white-space:nowrap}
      button{all:unset;cursor:pointer;background:#e5484d;color:#fff;font-weight:700;padding:7px 14px;border-radius:999px}
      button:hover{filter:brightness(1.1)}
      .x{background:transparent;color:#a8a8b4;padding:7px 8px;font-weight:600}
    </style><div class="b"><span class="t"></span><button class="s">정지 후 저장</button><button class="x" title="숨기기">✕</button></div>`;
    const t = root.querySelector('.t');
    const tick = () => {
      const r = [...recs.values()][0];
      if (!r) return;
      const s = Math.floor(recordedSec(r));
      t.textContent = `${r.heldAt ? `❚❚ ${r.why || '대기'}` : '● 녹화 중'} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
  // 녹화 중에 페이지를 닫거나 이동하면 녹화본이 사라진다. 브라우저의 "나가시겠습니까?" 확인을 띄운다.
  addEventListener('beforeunload', e => { if (recs.size && alive()) { e.preventDefault(); e.returnValue = ''; } });

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

  // audioOnly: 화면 없이 소리만 녹음해 저장한다 (배경음악·내레이션용)
  async function startRecording(id, fromStart, title, range, audioOnly) {
    if (recs.has(id) || starting.has(id)) return; // 버튼을 연달아 눌러도 한 번만 시작
    starting.add(id);
    try { await beginRecording(id, fromStart, title, range, audioOnly); } finally { starting.delete(id); }
  }
  async function beginRecording(id, fromStart, title, range, audioOnly) {
    const v = findVideo(id);
    if (!v) throw new Error('영상을 찾을 수 없습니다. 창을 새로고침(↻) 해주세요.');
    if (adShowing()) {
      throw new Error('유튜브 광고가 재생 중입니다. 광고가 끝난 뒤 다시 눌러주세요.');
    }

    const bounded = fromStart || !!range; // 끝이 정해진 녹화: 되감기면 종료
    const startAt = range ? range.from : 0;
    await v.play().catch(() => {});

    let source;
    try {
      source = v.captureStream();
    } catch (e) {
      throw new Error('이 영상은 녹화가 차단되어 있습니다. (외부 출처/보호된 영상) 위의 "바로 다운로드"를 이용하세요.');
    }
    // 영상·소리 트랙은 재생이 시작된 뒤 조금 늦게 붙는 경우가 있다. 붙기 전에 녹화를 시작하면
    // 나중에 트랙이 추가되는 순간 녹화기가 오류로 멈추거나 소리 없는 파일이 된다. 그래서 잠깐 기다린다.
    const until = async (ok, ms) => { for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms;) await new Promise(r => setTimeout(r, 50)); return ok(); };
    if (!(await until(() => source.getVideoTracks().length > 0, 4000))) {
      throw new Error('아직 영상이 준비되지 않았습니다. 영상을 재생한 뒤 다시 눌러주세요.');
    }
    const hasSound = () => v.webkitAudioDecodedByteCount > 0 || v.mozHasAudio || (v.audioTracks && v.audioTracks.length > 0);
    await until(() => source.getAudioTracks().length > 0, hasSound() ? 2000 : 700);
    // 지금 있는 트랙만 담은 별도 스트림으로 녹화한다. 원래 스트림에 트랙이 더해지거나 빠져도 녹화기는 영향을 받지 않는다.
    if (audioOnly && !source.getAudioTracks().length) throw new Error('이 영상에는 소리가 없습니다.');
    const stream = audioOnly ? new MediaStream(source.getAudioTracks().slice(0, 1))
      : new MediaStream([source.getVideoTracks()[0], ...source.getAudioTracks().slice(0, 1)]);
    // 준비가 끝난 뒤에 시작 지점으로 옮긴다. 먼저 옮기고 기다리면 그동안 영상이 흘러가 앞부분이 잘린다.
    if (bounded && Math.abs(v.currentTime - startAt) > 0.2) {
      v.currentTime = startAt;
      await once(v, 'seeked', 3000);
    }

    const AUDIO_MIMES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    const mimeType = audioOnly ? AUDIO_MIMES.find(t => MediaRecorder.isTypeSupported(t)) || '' : pickMime();
    await loadSettings(); // 방금 바꾼 화질 설정도 반영
    let recorder;
    try {
      recorder = new MediaRecorder(stream, audioOnly ? { mimeType, audioBitsPerSecond: 192_000 }
        : { mimeType, videoBitsPerSecond: BITS[settings.quality] || BITS.high });
      recorder.start(1000);
    } catch (e) {
      throw new Error(e.name === 'SecurityError'
        ? '이 영상은 녹화가 차단되어 있습니다. 아래 "탭 녹화"를 이용하세요.'
        : '아직 영상이 준비되지 않았습니다. 영상을 재생한 뒤 다시 눌러주세요.');
    }
    const chunks = [];
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);

    recorder.onerror = e => {
      toast(`녹화 중 문제가 생겨 여기까지만 저장했습니다. (${e.error?.name || '오류'}) 계속 안 되면 "탭 녹화"를 이용해 보세요.`);
      stopRecording(id);
    };
    // 영상 트랙이 끊기면(영상이 바뀜 등) 더 받을 화면이 없으므로 여기까지 저장
    stream.getTracks()[0].addEventListener('ended', () => stopRecording(id));

    // 화면이 실제로 나아가고 있을 때만 녹화한다. 아래 경우에는 녹화를 쉬었다가 다시 이어 붙인다.
    //  - 사용자가 멈춤 / 유튜브 광고
    //  - 버퍼링: 통신이 느리거나 서버가 늦어 로딩 중일 때. 그대로 녹화하면 멈춘 화면과 무음이 파일에 들어간다.
    //  - 탐색(이동) 중
    let stuck = false;           // 재생 중인데 화면이 나아가지 않음 (버퍼링 이벤트를 주지 않는 플레이어 대비)
    let buffering = false;       // 플레이어가 "기다리는 중"이라고 알려 옴
    const state = () => v.paused ? '일시정지' : adShowing() ? '광고' : (buffering || stuck || v.seeking || v.readyState < 3) ? '버퍼링' : '';
    const sync = () => {
      const why = state(), r = recs.get(id);
      if (why) {
        if (recorder.state === 'recording') recorder.pause();
        if (r) { r.heldAt ||= Date.now(); r.why = why; }
      } else {
        if (recorder.state === 'paused') recorder.resume();
        if (r && r.heldAt) { r.heldMs += Date.now() - r.heldAt; r.heldAt = 0; }
      }
    };
    const onWait = () => { buffering = true; sync(); };
    const onGo = () => { buffering = false; stuck = false; sync(); };
    // 0.25초마다 재생 위치가 나아갔는지 본다. 0.5초 넘게 그대로면 버퍼링으로 보고, 다시 나아가면 푼다.
    let seenTime = v.currentTime, seenAt = Date.now();
    const watch = setInterval(() => {
      if (v.currentTime !== seenTime) { seenTime = v.currentTime; seenAt = Date.now(); if (stuck) { stuck = false; sync(); } }
      else if (!v.paused && !stuck && Date.now() - seenAt > 500) { stuck = true; sync(); }
    }, 250);

    let last = v.currentTime;
    const startTime = v.currentTime;
    let thumb = '';
    const onTime = () => {
      sync();
      if (adShowing()) { last = 0; return; } // 광고 중 시간 이동은 무시
      // 쇼츠/릴스/틱톡은 무한 반복 재생 → 끝에서 처음으로 돌아가면 한 바퀴 끝으로 보고 자동 종료.
      // 버퍼링 뒤 플레이어가 조금 뒤로 물러나거나 사용자가 살짝 되감는 것은 끝이 아니므로, 끝 근처에서 앞쪽으로 크게 돌아간 경우만 센다.
      const rangeEnd = range ? Math.min(range.to, Number.isFinite(v.duration) ? v.duration : range.to) : 0; // 끝을 영상 끝으로 둔 경우 range.to는 길이보다 크다
      const looped = v.currentTime < last - 0.5 && (range ? v.currentTime < range.from - 0.3 || last >= rangeEnd - 1
        : v.currentTime < 1.5 && (!Number.isFinite(v.duration) || last > v.duration - 2));
      if (bounded && looped) return stopRecording(id);
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
    const handlers = { pause: sync, play: sync, timeupdate: onTime, ended: onStop, emptied: onSwap,
      waiting: onWait, playing: onGo, canplay: sync, seeking: sync, seeked: sync };
    for (const [ev, fn] of Object.entries(handlers)) v.addEventListener(ev, fn);

    const cleanup = () => {
      clearInterval(watch);
      for (const [ev, fn] of Object.entries(handlers)) v.removeEventListener(ev, fn);
      recs.delete(id);
      syncState();
    };

    recorder.onstop = async () => {
      cleanup();
      if (!chunks.length) return toast('녹화된 내용이 없습니다. 영상이 재생되는 상태에서 다시 시도해 주세요.');
      const type = recorder.mimeType || mimeType || 'video/webm';
      const ext = audioOnly ? (type.includes('mp4') ? 'm4a' : 'weba') : type.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      const filename = `${safeName(title || document.title)}.${ext}`; // 예비 저장용 이름
      // 자동 종료(영상 끝·한 바퀴 재생)는 클릭 없이 저장되므로, 다른 도메인·샌드박스 프레임에서도
      // 막히지 않는 브라우저 다운로드 기능으로 저장한다. 실패하면 링크 클릭으로 한 번 더 시도.
      const res = await tell({ type: 'save-blob', url, title: title || document.title, ext,
        kind: audioOnly ? '소리 저장' : range ? '구간 녹화' : '영상 녹화', thumb: thumb || thumbOf(v) });
      if (!res?.ok) {
        const a = Object.assign(document.createElement('a'), { href: url, download: filename });
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    };

    recs.set(id, { recorder, startedAt: Date.now(), heldMs: 0, heldAt: 0, why: '' });
    sync(); // 자동재생이 막혀 멈춰 있거나 아직 로딩 중이면 재생될 때까지 대기
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
    if (src && (cross || /\.(mp4|m4v|webm|mov|ogv|mkv)$/i.test(new URL(src).pathname))) { // 주소 뒤의 ?… #… 는 빼고 판단
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
    if (msg.type === 'capture-page') {
      if (window !== top) return;
      capturePage(msg.title).then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'scan') { sendResponse({ urls: scanPage() }); return; }
    if (msg.type === 'list') { sendResponse({ videos: list(), title: document.title }); return; }
    if (msg.type === 'record') {
      startRecording(msg.id, msg.fromStart, msg.title, msg.range, msg.audioOnly)
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
