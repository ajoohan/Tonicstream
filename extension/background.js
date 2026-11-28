importScripts('naming.js');

// 탭별로 네트워크에서 지나가는 "완전한 영상 파일" 주소를 모아 둔다.
// 유튜브처럼 조각(세그먼트)으로 나눠 스트리밍하는 영상은 여기서 잡히지 않으며,
// 팝업의 "녹화 저장"으로 처리한다.

const MAX_PER_TAB = 30;

// 틱톡 영상 서버는 tiktok.com에서 온 요청만 허용하므로,
// 확장 프로그램이 시작한 다운로드(탭 밖 요청, tabId -1)에만 Referer를 붙여준다.
const TIKTOK_CDN = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'tiktokv.us', 'tiktok.com', 'byteoversea.com', 'ibytedtos.com'];
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.tiktok.com/' }],
    },
    // initiatorDomains: 이 확장이 보낸 요청에만 적용 (틱톡 사이트 자체의 백그라운드 요청은 건드리지 않음)
    condition: { requestDomains: TIKTOK_CDN, initiatorDomains: [chrome.runtime.id], tabIds: [-1], resourceTypes: ['xmlhttprequest', 'other'] },
  }],
}).catch(e => console.warn('TikTok 규칙 등록 실패', e));
let mediaP; // { [tabId]: [{url, type, size, ts}] }
const load = () => (mediaP ??= chrome.storage.session.get('media').then(r => r.media || {}));
const save = media => chrome.storage.session.set({ media });

function header(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name)?.value || '';
}

function totalSize(headers) {
  const range = header(headers, 'content-range'); // bytes 0-999/123456
  const m = range.match(/\/(\d+)$/);
  if (m) return Number(m[1]);
  return Number(header(headers, 'content-length')) || 0;
}

// 바로 받을 수 있는 영상 파일 형식. 확장자와 서버가 알려 주는 형식(content-type) 둘 다 본다.
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv)$/i;
const EXT_OF_TYPE = { 'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-matroska': 'mkv' };
// 조각 스트리밍(HLS·DASH)의 목록 파일. 이런 페이지는 영상이 조각으로 나뉘어 와서 원본 파일이 따로 없다.
const STREAM_TYPE = /^application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)$|^audio\/(x-)?mpegurl$/;
const STREAM_EXT = /\.(m3u8|mpd)$/i;

function looksLikeVideo(type, url, headers) {
  if (/^video\//.test(type)) return !/^video\/(mp2t|iso\.segment|vnd\.dlna\.mpeg-tts)$/.test(type); // TS 조각 제외
  // 주소가 .mp4로 끝나도 서버가 웹 문서 등 다른 형식이라고 알려 주면 영상이 아니다 (파일 보기 페이지 등)
  if (VIDEO_EXT.test(url.pathname)) return !/^(text|image|font)\/|^application\/(json|xml|xhtml\+xml|javascript|pdf)$|\+(xml|json)$/.test(type);
  // 형식을 "일반 파일"로만 알려 주는 서버: 내려받을 파일 이름이 영상이면 영상으로 본다
  return /octet-stream/.test(type) && /filename[^;]*\.(mp4|m4v|webm|mov|ogv|mkv)/i.test(header(headers, 'content-disposition'));
}

function isSegmentUrl(u) {
  // MSE 스트리밍 조각: 단독 재생이 안 되므로 목록에서 제외
  return u.hostname.endsWith('googlevideo.com') ||
    /[?&](range|sq|bytestart)=/.test(u.search) ||
    /\.(m4s|ts)$/i.test(u.pathname) ||
    /\/(range|segment)[\/-]/i.test(u.pathname); // Vimeo 등 DASH/HLS 조각 경로
}

chrome.webRequest.onHeadersReceived.addListener(
  async details => {
    if (details.tabId < 0) return;
    if (details.documentLifecycle && details.documentLifecycle !== 'active') return; // 미리 불러오는 페이지의 것은 세지 않는다
    if (details.statusCode !== 200 && details.statusCode !== 206) return; // 리다이렉트·오류 응답 제외
    const type = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    const url = new URL(details.url);
    if (STREAM_TYPE.test(type) || STREAM_EXT.test(url.pathname)) { markStream(details.tabId, details.timeStamp, details.url, /dash/.test(type) || /\.mpd$/i.test(url.pathname) ? 'dash' : 'hls', details.initiator); return; }
    if (!looksLikeVideo(type, url, details.responseHeaders) || isSegmentUrl(url)) return;
    const size = totalSize(details.responseHeaders);
    const sizeKnown = !!(header(details.responseHeaders, 'content-range') || header(details.responseHeaders, 'content-length'));
    if (sizeKnown && size < 100 * 1024) return; // 빈 응답, 아이콘/미리보기 같은 아주 작은 파일 제외

    const media = await load();
    const list = (media[details.tabId] ||= []);
    // 같은 주소를 다시 불러오면(프레임을 새로 만든 경우 등) 지금 문서의 것으로 바꿔 맨 앞에 둔다.
    // 처음 본 문서 ID를 그대로 두면 팝업이 "다른 페이지의 파일"로 보고 숨긴다.
    const old = list.findIndex(m => m.url === details.url);
    if (old >= 0) {
      const [m] = list.splice(old, 1);
      list.unshift({ ...m, size: size || m.size, ts: details.timeStamp, documentId: details.documentId || m.documentId });
      save(media);
      return;
    }
    // documentId: 이 파일을 불러온 문서. 뒤로 가기로 예전 페이지가 되살아났을 때 다른 페이지의 파일이 섞이지 않게 팝업에서 걸러낸다
    list.unshift({ url: details.url, type: type || 'video/mp4', size, ts: details.timeStamp, documentId: details.documentId || '' });
    list.length = Math.min(list.length, MAX_PER_TAB);
    save(media);
    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

// 배지: 탭/영상 녹화 중이면 REC, 아니면 감지된 원본 파일 개수
async function updateBadge(tabId) {
  const [media, { tabRec, videoRecs, screenRec }] = await Promise.all([load(), chrome.storage.session.get(['tabRec', 'videoRecs', 'screenRec'])]);
  const rec = !!screenRec || tabRec?.tabId === tabId || !!videoRecs?.[tabId]?.length;
  const n = media[tabId]?.length || 0;
  // 녹화가 끝나면 색을 되돌리고, 표시할 것이 없으면 탭별 글자를 비워(null) 전체 배지(화면 녹화 REC)를 따르게 한다
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: rec ? '#e5484d' : '#5f6368' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: rec ? 'REC' : n ? String(n) : null }).catch(() => {});
  } catch { chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); }
}

// before: 새 페이지의 응답 시각. 그보다 먼저 받은 것(이전 페이지의 파일)만 지운다.
// 배경이 잠들어 있다 깨어날 때는 "페이지가 바뀜" 신호가 "영상 파일 발견" 신호보다 늦게 도착할 수 있다.
// 도착 순서로 지우면 새 페이지에서 방금 찾은 파일까지 지워지므로, 실제 발생 시각으로 판단한다.
async function clearTab(tabId, before = Infinity) {
  await streamTabsReady;
  if ((streamTabs.get(tabId)?.ts ?? Infinity) < before || before === Infinity) {
    if (streamTabs.delete(tabId)) chrome.storage.session.set({ streamTabs: [...streamTabs] });
  }
  const media = await load();
  if (!media[tabId]) return;
  const keep = media[tabId].filter(m => m.ts >= before);
  if (keep.length === media[tabId].length) return;
  if (keep.length) media[tabId] = keep; else delete media[tabId];
  save(media);
  updateBadge(tabId);
}

// 조각 스트리밍을 쓰는 탭. 팝업이 "원본 파일이 없는 이유"를 알려 주는 데 쓴다.
// 탭 → { ts: 처음 본 시각, hls: [{ url: 조각 목록(HLS m3u8·DASH mpd) 주소, kind: 'hls'|'dash', from: 그것을 불러온 프레임의 출처 }] }
const streamTabs = new Map();
const HLS_KEEP = 12; // 탭마다 기억하는 조각 목록 수 (최근 것부터)
// 배경이 잠들었다 깨어난 직후에는 저장해 둔 값을 다 읽기 전일 수 있으므로, 쓰는 곳마다 이 약속(promise)을 기다린다
const streamTabsReady = chrome.storage.session.get('streamTabs').then(r => (r.streamTabs || []).forEach(([t, v]) => streamTabs.has(t) || streamTabs.set(t, typeof v === 'object' && v ? { ts: v.ts, hls: (v.hls || []).map(h => typeof h === 'string' ? { url: h, from: '' } : h) } : { ts: v, hls: [] })), () => {});
async function markStream(tabId, ts, url, kind, from) {
  await streamTabsReady;
  const s = streamTabs.get(tabId) || { ts, hls: [] };
  const had = streamTabs.has(tabId);
  // 플레이어는 화질 목록과 화질별 조각 목록을 여러 개 불러온다. 받을 때 그중에서 고르도록 주소를 모아 둔다.
  // 한 탭에서 영상을 여러 개 보면 계속 쌓이므로 최근 것만 남긴다 (맨 뒤가 가장 최근).
  const last = s.hls[s.hls.length - 1];
  const changed = !!kind && last?.url !== url;
  if (changed) {
    s.hls = s.hls.filter(h => h.url !== url);
    s.hls.push({ url, kind, from: /^https?:/.test(from || '') ? from : '' });
    if (s.hls.length > HLS_KEEP) s.hls.splice(0, s.hls.length - HLS_KEEP);
  }
  if (had && !changed) return;
  streamTabs.set(tabId, s);
  chrome.storage.session.set({ streamTabs: [...streamTabs] });
}

// ── 페이지에서 찾은 영상 주소 확인 ───────────────────────
// content.js가 페이지 안에서 찾은 후보 주소(아직 재생하지 않은 영상, 링크, 공유용 정보 등)를 서버에 물어
// 실제 영상 파일인 것만 "바로 다운로드" 목록에 넣는다. 같은 주소는 한 번만 묻는다.
const probed = new Map(); // 주소 → 확인 결과(null이면 영상 아님)
async function probeOne(url) {
  if (probed.has(url)) return probed.get(url);
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || isSegmentUrl(u) || STREAM_EXT.test(u.pathname)) { probed.set(url, null); return null; }
  // 페이지에 적힌 주소로 보내는 요청이므로 로그인 정보(쿠키)는 싣지 않는다
  const ask = init => fetch(url, { credentials: 'omit', ...init }).then(r => {
    r.body?.cancel().catch(() => {});
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const range = r.headers.get('content-range')?.match(/\/(\d+)$/);
    const size = range ? Number(range[1]) : (init.method === 'HEAD' ? Number(r.headers.get('content-length')) || 0 : 0);
    return { type, size, disp: r.headers.get('content-disposition') || '' };
  }, () => null);
  // HEAD를 막는 서버가 많아, 안 되면 첫 1바이트만 받아 확인한다
  const info = (await ask({ method: 'HEAD' })) || (await ask({ headers: { Range: 'bytes=0-0' } }));
  if (!info) return null; // 응답을 못 받은 경우는 기억하지 않아, 다음에 다시 물어볼 수 있게 한다
  const ok = info && looksLikeVideo(info.type, u, [{ name: 'content-disposition', value: info.disp }]) && !STREAM_TYPE.test(info.type)
    && !(info.size && info.size < 100 * 1024);
  const result = ok ? { type: /^video\//.test(info.type) ? info.type : 'video/mp4', size: info.size } : null;
  if (probed.size > 500) probed.clear();
  probed.set(url, result);
  return result;
}
async function probeMedia(tabId, items) {
  const media = await load();
  const known = new Set((media[tabId] || []).map(m => m.url.split('#')[0]));
  const docOf = new Map(items.map(x => [String(x.url).split('#')[0], String(x.documentId || '')]));
  // 이미 "영상 아님"으로 확인된 주소는 빼고 고른다. 그러지 않으면 그것들이 한도(12개)를 차지해 뒤쪽 진짜 영상을 영영 확인하지 못한다.
  const fresh = [...docOf.keys()].filter(u => !known.has(u) && probed.get(u) !== null).slice(0, 12);
  const results = await Promise.all(fresh.map(async url => ({ url, info: await probeOne(url) })));
  const found = results.filter(r => r.info);
  if (!found.length) return 0;
  const now = await load();
  const list = (now[tabId] ||= []);
  for (const { url, info } of found) {
    if (!list.some(m => m.url.split('#')[0] === url)) list.push({ url, type: info.type, size: info.size, ts: Date.now(), documentId: docOf.get(url) || '', found: true });
  }
  list.length = Math.min(list.length, MAX_PER_TAB);
  save(now);
  updateBadge(tabId);
  return found.length;
}

chrome.tabs.onRemoved.addListener(tabId => { clearTab(tabId); setVideoRec(tabId, null, false); });
// 영상 녹화 상태는 여기서 지우지 않는다: 파일 다운로드 링크처럼 페이지가 바뀌지 않는 이동 요청도 있기 때문.
// 실제로 페이지를 떠날 때는 content.js가 알려준다(pagehide).
// 감지된 파일 목록은 새 페이지가 실제로 열릴 때만 비운다. 파일 다운로드 링크(첨부), 내용 없는 응답(204),
// 미리 불러오기(prerender)는 지금 페이지를 바꾸지 않으므로 건드리지 않는다.
chrome.webRequest.onHeadersReceived.addListener(
  d => {
    if (d.tabId < 0 || d.frameId !== 0 || (d.documentLifecycle && d.documentLifecycle !== 'active')) return;
    // 오류 페이지(404·500 등)도 화면을 바꾸므로 비운다. 페이지가 안 바뀌는 것(이동 중인 3xx, 내용 없는 204·205)만 건너뛴다.
    if (d.statusCode < 200 || (d.statusCode >= 300 && d.statusCode < 400) || d.statusCode === 204 || d.statusCode === 205) return;
    if (/attachment/i.test(header(d.responseHeaders, 'content-disposition'))) return;
    // zip·실행 파일처럼 화면에 열리지 않고 다운로드되는 형식도 페이지를 바꾸지 않는다
    const type = header(d.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    const opensInTab = /^(text|image|video|audio)\/|^application\/(xhtml\+xml|xml|pdf|json|javascript)$|\+(xml|json)$/.test(type)
      && !/^text\/(csv|calendar|x-vcard|vcard|tab-separated-values)$|^image\/tiff$|^video\/x-matroska$|^audio\/x-(ms-wma|aiff)$/.test(type);
    if (type && !opensInTab) return;
    clearTab(d.tabId, d.timeStamp);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders']
);

// 확장 자체 화면(팝업·보관함·녹화 창·숨겨진 페이지)에서만 받는 요청. 웹페이지에 들어간 content.js가 보낸 것은 거절한다.
const captureTabs = new Set(); // 페이지 전체 캡처가 진행 중인 탭
const EXT_ONLY = new Set(['capture-start', 'tabrec-start', 'tabrec-stop', 'tabrec-ended', 'download', 'shot-tab', 'log-save', 'library-update', 'probe-media',
  'library-import', 'hls-start', 'hls-cancel', 'hls-stop', 'hls-clear', 'hls-probe', 'hls-host', 'hls-progress', 'hls-done', 'add-streams']);
const SAVE_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv', 'png', 'm4a', 'weba']);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (EXT_ONLY.has(msg.type) && !_sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if ((msg.type === 'save-blob' || msg.type === 'download') && !SAVE_EXTS.has(msg.ext)) {
    sendResponse({ ok: false, error: '지원하지 않는 파일 형식입니다.' });
    return;
  }
  if (msg.type === 'save-blob' && !/^blob:/.test(msg.url || '')) { sendResponse({ ok: false, error: '잘못된 요청입니다.' }); return; }
  if (msg.type === 'tabrec-start') {
    startTabRecording(msg.tabId, msg.streamId, msg.title, msg.pageUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'tabrec-stop') { stopTabRecording().then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'tabrec-status') { chrome.storage.session.get('tabRec').then(r => sendResponse(r.tabRec || null)); return true; }
  if (msg.type === 'tabrec-ended') {
    // 숨겨진 페이지에서 녹화가 끝남 (정지 버튼, 탭 닫힘, 공유 중단 모두 여기로 옴)
    onTabRecEnded(msg);
    return;
  }
  if (msg.type === 'videorec-state') {
    if (_sender.tab?.id >= 0) setVideoRec(_sender.tab.id, _sender.frameId, msg.recording);
    return;
  }
  // 프레임 안(끼워 넣은 플레이어 등)에서 보낸 저장 요청은 그 프레임의 제목이 비어 있는 경우가 많아 탭 제목을 쓴다
  if ((msg.type === 'save-video-url' || msg.type === 'save-blob') && _sender.tab && (_sender.frameId || !String(msg.title || '').trim())) {
    msg.title = _sender.tab.title || msg.title;
  }
  if (msg.type === 'save-video-url') {
    // 페이지의 "저장" 버튼(content.js)이 보낸 원본 영상 주소 저장. 영상 파일 형식만 허용한다.
    // 주소가 영상 파일(.mp4 등)이거나, 그 탭에서 실제로 영상으로 받아진 것이 확인된 주소여야 한다.
    let u = null;
    try { u = new URL(msg.url); } catch {}
    if (!_sender.tab || !u || !/^https?:$/.test(u.protocol)) { sendResponse({ ok: false, error: '잘못된 요청입니다.' }); return; }
    load().then(async media => {
        const EXT_OF = EXT_OF_TYPE;
        const bare = s => s.split('#')[0];
        const seen = (media[_sender.tab.id] || []).find(f => bare(f.url) === bare(msg.url));
        const byPath = u.pathname.match(VIDEO_EXT)?.[1].toLowerCase();
        let ext = byPath || (seen && (EXT_OF[seen.type] || 'mp4')); // 이 탭에서 영상으로 확인된 주소면 형식 이름을 몰라도 받는다
        // 목록에 없는 주소(오래돼 밀려났거나 리다이렉트된 경우)는 서버에 파일 형식만 물어 확인한다
        if (!ext) {
          const typeOf = init => fetch(msg.url, { credentials: 'include', ...init })
            .then(r => { r.body?.cancel().catch(() => {}); return r.ok ? (r.headers.get('content-type') || '') : ''; }, () => '');
          // HEAD를 막는 서버가 많아, 안 되면 첫 1바이트만 받아 형식을 확인한다
          const type = (await typeOf({ method: 'HEAD' })) || (await typeOf({ headers: { Range: 'bytes=0-0' } }));
          const t = type.split(';')[0].trim().toLowerCase();
          ext = EXT_OF[t] || (/^video\//.test(t) && !/^video\/(mp2t|iso\.segment)$/.test(t) ? 'mp4' : undefined);
        }
        if (!ext) throw new Error('영상 파일로 확인되지 않은 주소입니다.');
        return buildName(msg.title, _sender.tab.url, ext);
      })
      .then(async filename => {
        const id = await download(msg.url, filename);
        // 서버가 곧바로 거절한 경우(403, 만료된 주소 등) 성공으로 답하지 않는다
        if (await failedEarly(id)) throw new Error('서버가 다운로드를 거절했습니다.');
        logSave({ kind: '원본 다운로드', title: msg.title, pageUrl: _sender.tab.url, filename, downloadId: id, thumb: msg.thumb, incognito: _sender.tab.incognito });
        return id;
      })
      .then(id => sendResponse({ ok: true, id }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'save-blob') {
    buildName(msg.title, _sender.tab?.url || _sender.url, msg.ext, { suffix: msg.suffix })
      .then(async filename => {
        const id = await safeDownload(msg.url, filename);
        // 시크릿 창처럼 배경이 페이지의 임시 주소를 읽지 못하는 경우 저장이 곧바로 실패한다.
        // 그때는 실패로 답해, 페이지가 링크 클릭 방식으로 직접 저장하게 한다.
        if (await failedEarly(id)) throw new Error('저장을 시작하지 못했습니다.');
        logSave({ kind: msg.kind || '영상 녹화', title: msg.title, pageUrl: _sender.tab?.url || '', filename, downloadId: id, thumb: msg.thumb, incognito: _sender.tab?.incognito });
        return id;
      })
      .then(id => sendResponse({ ok: true, id }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  // 페이지 전체 캡처: 팝업이 시작을 알린 탭에서만, 그 탭의 content.js가 화면을 한 장씩 요청할 수 있다
  if (msg.type === 'capture-start') { captureTabs.add(msg.tabId); sendResponse({ ok: true }); return; }
  if (msg.type === 'capture-end') {
    // 페이지(content.js)는 자기 탭만, 팝업은 시작을 알렸던 탭을 끝낼 수 있다
    if (_sender.tab) captureTabs.delete(_sender.tab.id);
    else if (_sender.url?.startsWith(chrome.runtime.getURL(''))) captureTabs.delete(msg.tabId);
    return;
  }
  if (msg.type === 'capture-visible') {
    const t = _sender.tab;
    if (!t || !captureTabs.has(t.id)) { sendResponse({ ok: false, error: '캡처가 시작되지 않았습니다.' }); return; }
    chrome.tabs.query({ active: true, windowId: t.windowId })
      .then(([active]) => { if (active?.id !== t.id) throw new Error('캡처하는 동안 이 탭을 그대로 띄워 두어야 합니다.'); return chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' }).catch(async e => {
        if (!/MAX_CAPTURE|quota/i.test(e.message)) throw e;
        await new Promise(r => setTimeout(r, 1100));
        return chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
      }); })
      .then(dataUrl => sendResponse({ ok: true, dataUrl }), e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'shot-tab') {
    shotTab(msg).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'log-save') { logSave(msg.entry); return; }
  // 보관함 백업 파일 가져오기: 같은 기록(id)은 건너뛰고 새 것만 더한다
  if (msg.type === 'library-import') { importLibrary(msg.items).then(sendResponse, e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.type === 'library-update') {
    // 전체 삭제는 clearAll로만. id가 빠진 요청이 전체 삭제로 읽히지 않게 한다.
    if (!msg.clearAll && typeof msg.id !== 'string') { sendResponse({ ok: false }); return; }
    updateLibrary(msg.clearAll ? null : msg.id, msg.change).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'getMedia') {
    load().then(media => sendResponse(media[msg.tabId] || []));
    return true;
  }
  if (msg.type === 'probe-media') {
    probeMedia(msg.tabId, Array.isArray(msg.items) ? msg.items.filter(x => x && typeof x.url === 'string') : []).then(n => sendResponse({ added: n }), () => sendResponse({ added: 0 }));
    return true;
  }
  if (msg.type === 'has-stream') { streamTabsReady.then(() => sendResponse(streamTabs.has(msg.tabId))); return true; }
  if (msg.type === 'get-stream') {
    // 확장 화면(팝업)만 목록을 본다. 웹페이지에 들어간 content.js에는 알려 주지 않는다.
    if (!_sender.url?.startsWith(chrome.runtime.getURL(''))) { sendResponse({ any: false, lists: [], jobs: [] }); return; }
    Promise.all([streamTabsReady, jobsNow()]).then(([, jobs]) =>
      // 시크릿 창에서 더한 다운로드는 시크릿 창의 팝업에서만 보인다
      sendResponse({ any: streamTabs.has(msg.tabId), lists: streamTabs.get(msg.tabId)?.hls || [],
        jobs: jobs.filter(j => !j.incognito || msg.incognito).map(({ urls, ...j }) => j) }));
    return true;
  }
  // 팝업이 페이지 안에서 찾아낸 조각 목록 주소 (확장이 켜지기 전에 불러온 것 등)
  if (msg.type === 'add-streams') {
    const items = (Array.isArray(msg.items) ? msg.items : []).filter(u => typeof u === 'string' && /^https?:/.test(u)).slice(0, 12);
    (async () => { for (const u of items) await markStream(msg.tabId, Date.now(), u, /\.mpd(\?|$)/i.test(u) ? 'dash' : 'hls', ''); })()
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'hls-probe') { hlsProbe(msg).then(sendResponse, e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.type === 'hls-start') { hlsEnqueue(msg).then(sendResponse, e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.type === 'hls-stop') { hlsStop(String(msg.id)).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'hls-cancel') { hlsCancel(String(msg.id)).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'hls-clear') { hlsClear().then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'hls-host') { allowHost(msg.origin, msg.host, msg.job).then(r => sendResponse({ ok: !r.busy, busy: r.busy })); return true; }
  if (msg.type === 'hls-progress') { hlsProgress(msg); return; }
  if (msg.type === 'hls-done') { hlsDone(msg); return; }
  if (msg.type === 'download') {
    let path = '';
    try { path = new URL(msg.url).pathname; } catch {}
    if (STREAM_EXT.test(path)) { sendResponse({ ok: false, error: '스트리밍 방식 영상이라 파일로 받을 수 없습니다.' }); return; }
    buildName(msg.title, msg.pageUrl, msg.ext, { suffix: msg.suffix }) // suffix: 한꺼번에 받을 때 붙이는 번호
      .then(async filename => {
        const id = await download(msg.url, filename);
        // 서버가 곧바로 거절한 경우(403, 만료된 주소 등) 성공으로 답하지 않는다
        if (await failedEarly(id)) throw new Error('서버가 다운로드를 거절했습니다.');
        logSave({ kind: '원본 다운로드', title: msg.title, pageUrl: msg.pageUrl, filename, downloadId: id, thumb: msg.thumb, incognito: msg.incognito });
        return id;
      })
      .then(id => sendResponse({ ok: true, id }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

const isTikTokCdn = url => {
  try { const h = new URL(url).hostname; return TIKTOK_CDN.some(d => h === d || h.endsWith('.' + d)); } catch { return false; }
};

let fetchesInFlight = 0; // 숨겨진 페이지에서 받는 중인 틱톡 영상 수
const EXT_BLOB = `blob:chrome-extension://${chrome.runtime.id}/`;

async function download(url, filename) {
  if (!isTikTokCdn(url)) return safeDownload(url, filename);
  // 틱톡: 다운로드 API 요청에는 Referer를 붙일 수 없어서, 숨겨진 페이지에서 받아 저장
  fetchesInFlight++;
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: 'offscreen-fetch', url });
    if (!res?.ok) throw new Error(res?.error || '받기 실패');
    // 저장이 시작된 뒤(in_progress)에 카운트를 내려야 숨겨진 페이지가 먼저 닫히지 않는다
    const id = await safeDownload(res.url, filename);
    offscreenBlobs.set(id, res.url); // 저장이 끝나면 숨겨진 페이지가 잡고 있는 영상 데이터를 놓아 준다
    return id;
  } finally {
    fetchesInFlight--;
    maybeCloseOffscreen();
  }
}

// 동시에 두 번 불려도 문서를 한 번만 만들도록 진행 중인 생성 작업을 공유
let creatingOffscreen = null;
let closingOffscreen = null;
// 저장이 시작 직후(약 1초 안)에 실패했는지
async function failedEarly(id) {
  for (let i = 0; i < 5; i++) {
    const [d] = await chrome.downloads.search({ id });
    if (!d || d.state === 'interrupted') return true;
    if (d.state === 'complete' || d.bytesReceived > 0) return false;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function ensureOffscreen() {
  await closingOffscreen; // 닫는 중이면 끝난 뒤에 새로 만든다 (닫히는 페이지에 일을 맡기지 않게)
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS', 'USER_MEDIA'], justification: '영상 파일 저장, 스트리밍 영상 받기, 탭 녹화',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

// 숨겨진 페이지는 받는 중인 파일, 탭 녹화, 확장이 만든 임시 파일(blob)의 저장이 모두 끝났을 때만 닫는다.
// 저장 건수를 세지 않고 매번 실제 상태를 확인하므로, 화면 녹화 저장 등이 섞여도 어긋나지 않는다.
let tabRecStarting = 0;
async function maybeCloseOffscreen() {
  if (fetchesInFlight > 0 || creatingOffscreen || tabRecStarting) return;
  const [{ tabRec }, active] = await Promise.all([
    chrome.storage.session.get('tabRec'),
    chrome.downloads.search({ state: 'in_progress' }),
  ]);
  if (hlsStarting || hlsProbing || ((await chrome.storage.session.get('hlsJobs')).hlsJobs || []).some(j => ACTIVE.has(j.state))) return; // 스트리밍을 받는 중이거나 대기 중
  if (tabRec || tabRecStarting || fetchesInFlight > 0 || active.some(d => d.url.startsWith(EXT_BLOB))) return;
  if (!(await chrome.offscreen.hasDocument())) return;
  // 위에서 기다리는 사이 새 작업이 시작됐을 수 있으므로 닫기 직전에 한 번 더 확인
  if (fetchesInFlight > 0 || creatingOffscreen || tabRecStarting || closingOffscreen || hlsStarting || hlsProbing) return;
  closingOffscreen = chrome.offscreen.closeDocument().catch(() => {}).finally(() => { closingOffscreen = null; });
  await closingOffscreen;
}

const offscreenBlobs = new Map(); // 다운로드 번호 → 숨겨진 페이지가 만든 임시 주소
chrome.downloads.onChanged.addListener(async d => {
  if (!d.state || d.state.current === 'in_progress') return;
  if (offscreenBlobs.has(d.id)) {
    const url = offscreenBlobs.get(d.id);
    offscreenBlobs.delete(d.id);
    // 스트리밍 결과는 디스크의 임시 파일이다. 지워졌다는 답을 받은 뒤에 숨겨진 페이지를 닫아야 파일이 남지 않는다.
    await chrome.runtime.sendMessage({ type: 'offscreen-revoke', url }).catch(() => {});
  }
  maybeCloseOffscreen();
});

// ── 탭 전체 녹화 ─────────────────────────────────────────
// 영상 요소 녹화가 막히는 사이트에서도 탭 화면+소리를 그대로 녹화한다.
// (DRM 영상은 브라우저가 검은 화면으로 내보내므로 녹화되지 않음)
async function startTabRecording(tabId, streamId, title, pageUrl) {
  const filename = await buildName(title, pageUrl); // 확장자는 녹화가 끝난 뒤 붙는다
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (tabRec || tabRecStarting) throw new Error('이미 다른 탭을 녹화 중입니다. 먼저 정지해 주세요.');
  // 시작하는 동안(녹화 상태가 기록되기 전) 다른 저장이 끝나도 숨겨진 페이지가 닫히지 않게 잠가 둔다
  tabRecStarting++;
  let rec, tab;
  try {
    tab = await chrome.tabs.get(tabId).catch(() => null);
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: 'offscreen-tabrec-start', streamId, filename, quality: qualityOf(await getNaming()) });
    if (!res?.ok) throw new Error(res?.error || '탭 녹화를 시작하지 못했습니다.');
    rec = { tabId, startedAt: Date.now(), title, pageUrl, thumb: '', incognito: !!tab?.incognito };
    await chrome.storage.session.set({ tabRec: rec });
  } finally {
    tabRecStarting--;
    if (!rec) maybeCloseOffscreen(); // 시작에 실패했으면 숨겨진 페이지를 정리
  }
  updateBadge(tabId);
  openTabRecControl(tabId);
  addTabRecThumb(rec, tab);
}

// 보관함용 미리보기: 녹화를 시작한 탭이 지금 보이는 탭이면 화면을 한 장 찍어 둔다 (녹화 시작을 늦추지 않게 따로 처리)
async function addTabRecThumb(rec, tab) {
  try {
    if (!tab?.active || tab.incognito || !(await getNaming()).library) return;
    const thumb = await makeThumb(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 }));
    // 그 사이 녹화가 끝났으면 상태를 되살리지 않도록, 종료 처리와 같은 대기열에서 확인 후 기록
    await (tabRecQueue = tabRecQueue.then(async () => {
      const { tabRec } = await chrome.storage.session.get('tabRec');
      if (tabRec?.startedAt === rec.startedAt) await chrome.storage.session.set({ tabRec: { ...tabRec, thumb } });
    }).catch(() => {}));
  } catch {}
}

// 탭별 아이콘 설정(정지 버튼·REC 배지)은 페이지를 이동하면 브라우저가 지우므로, 녹화 중인 탭이 이동하면 다시 맞춘다
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.status) return;
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (tabRec?.tabId === tabId) { refreshAction(); updateBadge(tabId); }
});

// 녹화 중 "정지 후 저장" 버튼이 항상 보이도록 작은 조절 창을 브라우저 창 오른쪽 아래에 띄운다.
// (별도 창이라 탭 녹화 화면에는 찍히지 않음)
async function openTabRecControl(tabId) {
  const W = 320, H = 200;
  const opts = { url: 'tabctl.html', type: 'popup', width: W, height: H, focused: true };
  try {
    const { windowId } = await chrome.tabs.get(tabId);
    const w = await chrome.windows.get(windowId);
    if (w.state === 'normal' || w.state === 'maximized') {
      // 왼쪽·위쪽 보조 모니터는 좌표가 음수이므로 0으로 막지 않고, 브라우저 창 안쪽으로만 맞춘다
      opts.left = Math.max(w.left, w.left + w.width - W - 24);
      opts.top = Math.max(w.top, w.top + w.height - H - 24);
    }
  } catch {}
  await chrome.windows.create(opts).catch(() => chrome.windows.create({ url: 'tabctl.html', type: 'popup', width: W, height: H }));
}

async function stopTabRecording() {
  // 실제 정리는 숨겨진 페이지가 보내는 'tabrec-ended'에서 처리
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-tabrec-stop' }).catch(() => null);
  if (!res?.recording) onTabRecEnded({}); // 숨겨진 페이지가 이미 없거나 녹화 중이 아니면 상태만 정리
}

// 종료 처리가 겹쳐 들어와도(정지 버튼 + 탭 닫힘 등) 하나씩 차례로 처리한다
let tabRecQueue = Promise.resolve();
function onTabRecEnded(msg) {
  tabRecQueue = tabRecQueue.then(() => finishTabRec(msg)).catch(e => console.warn(e));
  return tabRecQueue;
}
async function finishTabRec({ url, filename }) {
  // 저장을 먼저 시작한 뒤 녹화 상태를 지워야, 그 사이 숨겨진 페이지가 닫혀 임시 파일이 사라지지 않는다
  const id = url ? await safeDownload(url, filename).catch(e => console.warn('탭 녹화 저장 실패', e)) : null;
  const { tabRec } = await chrome.storage.session.get('tabRec');
  // 녹화 정보를 모르면(이미 정리됨) 시크릿 창 여부도 알 수 없으므로 보관함에 남기지 않는다
  if (id != null && tabRec) logSave({ kind: '탭 녹화', title: tabRec.title, pageUrl: tabRec.pageUrl, filename, downloadId: id, thumb: tabRec.thumb, incognito: tabRec.incognito });
  // 조절 창이 "저장했습니다 / 저장하지 못했습니다"를 바르게 보여주도록 결과를 남긴다
  if (tabRec) await chrome.storage.session.set({ tabRecResult: { saved: id != null, at: Date.now() } });
  await chrome.storage.session.remove('tabRec');
  if (tabRec) updateBadge(tabRec.tabId);
  maybeCloseOffscreen();
}

chrome.tabs.onRemoved.addListener(async tabId => {
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (tabRec?.tabId === tabId) stopTabRecording();
});

// ── 녹화 중 툴바 아이콘 = 정지 버튼 ─────────────────────
// 팝업은 페이지를 클릭하면 닫히므로, 녹화 중에는 아이콘(또는 Alt+Shift+V)을 한 번 누르면
// 팝업을 열지 않고 바로 정지·저장한다.

// 영상 요소 녹화 상태: { [tabId]: [frameId, ...] }  (frameId null = 탭 전체 정리)
// 여러 프레임이 동시에 알려와도 읽기-수정-쓰기가 겹치지 않도록 순서대로 처리
let videoRecQueue = Promise.resolve();
function setVideoRec(tabId, frameId, recording) {
  videoRecQueue = videoRecQueue.then(() => applyVideoRec(tabId, frameId, recording)).catch(e => console.warn(e));
  return videoRecQueue;
}
async function applyVideoRec(tabId, frameId, recording) {
  const { videoRecs = {} } = await chrome.storage.session.get('videoRecs');
  const frames = new Set(frameId == null ? [] : videoRecs[tabId] || []);
  if (recording) frames.add(frameId); else if (frameId != null) frames.delete(frameId);
  if (!frames.size && !videoRecs[tabId]) return;
  if (frames.size) videoRecs[tabId] = [...frames]; else delete videoRecs[tabId];
  await chrome.storage.session.set({ videoRecs });
  updateBadge(tabId);
}

// 탭·영상 녹화는 해당 탭에서만, 화면 녹화는 모든 탭에서 아이콘이 정지 버튼이 된다.
// 다른 탭에서는 평소처럼 팝업이 열린다.
let refreshQueue = Promise.resolve();
function refreshAction() {
  refreshQueue = refreshQueue.then(applyAction).catch(e => console.warn(e));
  return refreshQueue;
}
async function applyAction() {
  const { tabRec, screenRec, videoRecs = {}, stopTabs = [] } =
    await chrome.storage.session.get(['tabRec', 'screenRec', 'videoRecs', 'stopTabs']);
  const STOP = { popup: '', title: '녹화 중 · 클릭하면 정지 후 저장' };
  const NORMAL = { popup: 'popup.html', title: '영상 저장' };
  const base = screenRec ? STOP : NORMAL;
  await chrome.action.setPopup({ popup: base.popup });
  await chrome.action.setTitle({ title: base.title });
  const recTabs = new Set(Object.keys(videoRecs).map(Number));
  if (tabRec) recTabs.add(tabRec.tabId);
  // 전에 정지 버튼으로 바꿨던 탭도 함께 다시 맞춘다 (탭별 설정은 따로 지우는 방법이 없음)
  for (const tabId of new Set([...recTabs, ...stopTabs])) {
    const v = recTabs.has(tabId) ? STOP : base;
    await chrome.action.setPopup({ tabId, popup: v.popup }).catch(() => {});
    await chrome.action.setTitle({ tabId, title: v.title }).catch(() => {});
  }
  // 한 번이라도 바꾼 탭은 계속 기억해 두어야 이후 화면 녹화 시작·종료 때 함께 맞출 수 있다 (닫힌 탭은 제외)
  await chrome.storage.session.set({ stopTabs: [...new Set([...stopTabs, ...recTabs])] });
}
chrome.tabs.onRemoved.addListener(async tabId => {
  const { stopTabs = [] } = await chrome.storage.session.get('stopTabs');
  if (stopTabs.includes(tabId)) chrome.storage.session.set({ stopTabs: stopTabs.filter(t => t !== tabId) });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'session' || !(changes.tabRec || changes.screenRec || changes.videoRecs)) return;
  refreshAction();
  // 화면 녹화가 시작·종료되면 원본 파일 개수를 보여주던 탭들의 배지도 REC로 맞춘다
  if (changes.screenRec) {
    const { tabRec, videoRecs = {}, stopTabs = [] } = await chrome.storage.session.get(['tabRec', 'videoRecs', 'stopTabs']);
    const tabs = new Set([...Object.keys(await load()), ...Object.keys(videoRecs), ...stopTabs].map(Number));
    if (tabRec) tabs.add(tabRec.tabId);
    for (const tabId of tabs) updateBadge(tabId);
  }
});

// 화면 녹화 창이 정리 없이 사라져도(강제 종료 등) 녹화 중 표시가 남지 않게 한다
chrome.windows.onRemoved.addListener(async windowId => {
  const { screenRec } = await chrome.storage.session.get('screenRec');
  if (screenRec?.windowId !== windowId) return;
  await chrome.storage.session.remove('screenRec');
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
});
chrome.runtime.onStartup.addListener(refreshAction);
chrome.runtime.onInstalled.addListener(refreshAction);

// ── 우클릭 메뉴 ──
// 팝업을 열지 않고 영상 위에서 바로 저장·녹화·캡처한다. 영상이 다른 요소에 덮여 있어도 되도록 모든 곳에 메뉴를 띄우고,
// 실제 영상은 페이지(content.js)가 우클릭한 자리에서 찾는다.
const CTX = [
  ['save', '이 영상 저장 (원본이 있으면 원본, 없으면 녹화)'],
  ['record', '이 영상 처음부터 녹화'],
  ['shot', '지금 장면 캡처 (PNG)'],
  ['sheet', '장면 콘티 시트 만들기'],
  ['sep', ''],
  ['page', '페이지 전체 캡처'],
  ['library', '보관함 열기'],
];
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ts', title: 'Tonicstream', contexts: ['all'], documentUrlPatterns: ['http://*/*', 'https://*/*', 'file://*/*'] });
    for (const [id, title] of CTX) {
      chrome.contextMenus.create(id === 'sep' ? { id: 'ts-sep', parentId: 'ts', type: 'separator', contexts: ['all'] }
        : { id: `ts-${id}`, parentId: 'ts', title, contexts: ['all'] });
    }
  });
}
chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => { onMenu(info, tab); });
async function onMenu(info, tab) {
  const action = String(info.menuItemId).replace(/^ts-/, '');
  if (action === 'library') return chrome.tabs.create({ url: 'library.html' });
  if (!tab?.id || tab.id < 0) return;
  const frameId = info.frameId || 0;
  if (action === 'page' || action === 'sheet') captureTabs.add(tab.id); // 탭 화면을 찍을 수 있게 허락 (끝나면 거둔다)
  try {
    if (action === 'page') {
      await chrome.tabs.sendMessage(tab.id, { type: 'capture-page', title: tab.title }, { frameId: 0 });
      return;
    }
    const send = () => chrome.tabs.sendMessage(tab.id, { type: 'ctx', action, title: tab.title }, { frameId });
    // 확장을 설치하기 전에 열어 둔 탭에는 content.js가 없다. 넣은 뒤 한 번 더 시도한다 (이때는 우클릭 위치를 몰라 안내만 뜬다).
    const res = await send().catch(async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
      return send();
    });
    // 다른 도메인 영상의 장면 캡처: 그림을 꺼낼 수 없어 탭 화면을 찍어 영상 부분만 자른다
    if (action === 'shot' && res?.fallback) {
      await shotTab({ tabId: tab.id, windowId: tab.windowId, vw: res.vw, rect: res.top ? res.rect : null, title: tab.title, pageUrl: tab.url, suffix: res.suffix });
    }
  } catch (e) {
    console.warn('우클릭 메뉴 실행 실패', e); // 이 페이지에 content.js가 없는 경우(확장 설치 전에 연 탭 등)
  } finally {
    if (action === 'page' || action === 'sheet') captureTabs.delete(tab.id);
  }
}

// 녹화 중일 때만 호출됨 (평소엔 팝업이 열림)
async function stopFromAction(tab) {
  const { tabRec, screenRec, videoRecs = {} } = await chrome.storage.session.get(['tabRec', 'screenRec', 'videoRecs']);
  if (videoRecs[tab.id]?.length) {
    await chrome.tabs.sendMessage(tab.id, { type: 'stop-all' }).catch(() => {});
    // 응답이 없는 프레임(이미 사라진 페이지 등)은 상태만 정리
    setTimeout(async () => {
      const { videoRecs: v = {} } = await chrome.storage.session.get('videoRecs');
      if (v[tab.id]?.length) setVideoRec(tab.id, null, false);
    }, 3000);
    return;
  }
  if (tabRec?.tabId === tab.id) return stopTabRecording();
  if (screenRec) {
    const res = await chrome.runtime.sendMessage({ type: 'screenrec-stop' }).catch(() => null);
    if (!res?.recording) chrome.storage.session.remove('screenRec');
    return;
  }
  // 녹화 상태가 이미 끝났는데 아이콘만 남은 경우: 상태를 다시 맞추고 팝업을 연다
  await refreshAction();
  chrome.action.openPopup().catch(() => {});
}
chrome.action.onClicked.addListener(stopFromAction);

// ── 장면 캡처(스크린샷) 예비 방법 ─────────────────────────
// 다른 도메인에서 불러온 영상은 페이지 안에서 그림으로 꺼낼 수 없어서,
// 보이는 탭 화면을 찍은 뒤 영상 위치만 잘라 저장한다.
async function shotTab({ tabId, windowId, rect, vw, title, pageUrl, suffix }) {
  // 찍히는 것은 창에서 지금 보이는 탭이므로, 대상 탭이 맞는지 먼저 확인
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (tabId != null && active?.id !== tabId) throw new Error('영상이 있는 탭이 화면에 보이지 않습니다.');
  // 브라우저는 탭 화면 찍기를 1초에 2번까지만 허락한다. 바로 앞에서 찍었으면(콘티 시트 등) 잠깐 기다렸다가 다시 찍는다.
  let dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }).catch(async e => {
    if (!/MAX_CAPTURE|quota/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 1100));
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  });
  if (rect) {
    const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const dpr = vw ? img.width / vw : 1; // 찍힌 그림과 페이지 좌표의 비율 (화면 배율·확대/축소 반영)
    // 화면 밖으로 일부 나간 영상은 보이는 부분만 잘라낸다
    const x = Math.max(0, Math.round(rect.x * dpr)), y = Math.max(0, Math.round(rect.y * dpr));
    const w = Math.min(img.width, Math.round((rect.x + rect.w) * dpr)) - x, h = Math.min(img.height, Math.round((rect.y + rect.h) * dpr)) - y;
    if (w > 8 && h > 8) {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      dataUrl = await blobToDataUrl(await c.convertToBlob({ type: 'image/png' }));
    }
  }
  const filename = await buildName(title, pageUrl, 'png', { suffix });
  const id = await safeDownload(dataUrl, filename);
  logSave({ kind: '장면 캡처', title, pageUrl, filename, downloadId: id, thumb: await makeThumb(dataUrl).catch(() => ''), incognito: active?.incognito });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}

// 그림을 긴 변 240px 이하의 작은 JPEG로 줄인다 (보관함 미리보기용)
async function makeThumb(dataUrl) {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = Math.min(1, 240 / Math.max(img.width, img.height));
  const c = new OffscreenCanvas(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return blobToDataUrl(await c.convertToBlob({ type: 'image/jpeg', quality: 0.6 }));
}

// ── 레퍼런스 보관함 ─────────────────────────────────────
// 저장할 때마다 제목·원본 주소·날짜·미리보기를 이 브라우저에만 기록한다(chrome.storage.local).
// 영상 파일 자체는 보관하지 않는다. 설정에서 끌 수 있다.
const LIBRARY_MAX = 300;
const LIBRARY_HARD_MAX = 600; // 표시해 둔 기록만으로 이 수를 넘으면 그때는 가장 오래된 것부터 지운다
let libraryQueue = Promise.resolve();
// 저장한 페이지가 아직 열려 있으면 게시물 정보(계정·게시일·캡션·해시태그·조회수)를 받아 온다
async function metaOf(pageUrl) {
  if (!/^https?:/.test(pageUrl || '')) return null;
  try {
    const tabs = (await chrome.tabs.query({})).filter(t => t.url === pageUrl);
    const t = tabs.find(x => x.active) || tabs[0];
    if (!t) return null;
    const m = await Promise.race([chrome.tabs.sendMessage(t.id, { type: 'meta' }, { frameId: 0 }), new Promise(r => setTimeout(() => r(null), 1500))]);
    if (!m || typeof m !== 'object') return null;
    const str = (x, n) => String(x ?? '').slice(0, n);
    const out = { author: str(m.author, 80), published: str(m.published, 40), caption: str(m.caption, 600),
      hashtags: (Array.isArray(m.hashtags) ? m.hashtags : []).map(h => str(h, 40)).slice(0, 20),
      views: Number(m.views) > 0 ? Math.round(Number(m.views)) : 0, likes: Number(m.likes) > 0 ? Math.round(Number(m.likes)) : 0 };
    return out.author || out.published || out.caption || out.views || out.likes ? out : null;
  } catch { return null; }
}

function logSave(entry) {
  if (entry.incognito) return libraryQueue; // 시크릿 창에서 저장한 것은 기록하지 않는다
  const metaP = metaOf(entry.pageUrl).catch(() => null); // 대기열 밖에서 미리 받아 둔다 (다른 기록을 늦추지 않게)
  libraryQueue = libraryQueue.then(async () => {
    const naming = await getNaming();
    if (!naming.library) return;
    const { library = [] } = await chrome.storage.local.get('library');
    const [d] = entry.downloadId != null ? await chrome.downloads.search({ id: entry.downloadId }) : [];
    if (d?.state === 'interrupted') return; // 시작하자마자 실패한 저장(서버 거절 등)은 남기지 않는다
    library.unshift({
      id: crypto.randomUUID(), ts: Date.now(), kind: entry.kind || '', title: (entry.title || '').slice(0, 200),
      pageUrl: /^https?:/.test(entry.pageUrl || '') ? entry.pageUrl : '', site: siteOf(entry.pageUrl),
      filename: finalName(entry.filename || '', d?.filename), downloadId: entry.downloadId ?? null,
      // 미리보기는 보통 2~10KB. 저장 공간(브라우저 한도 약 10MB)을 넘지 않게 큰 것은 버린다
      thumb: (entry.thumb || '').length <= THUMB_MAX ? entry.thumb || '' : '', memo: '', tags: '',
      board: String(naming.board || '').slice(0, 40), rating: 0,
      ...(await metaP.then(meta => (meta ? { meta } : {}))),
    });
    // 한도를 넘으면 표시(보드·별점·메모·태그)가 없는 오래된 기록부터 지운다. 정리해 둔 기록은 최대한 남긴다.
    const marked = x => x.board || x.rating || x.memo || x.tags;
    while (library.length > LIBRARY_MAX) {
      let i = library.length - 1;
      while (i > 0 && marked(library[i])) i--;
      if (i === 0) { if (library.length > LIBRARY_HARD_MAX) library.pop(); else break; }
      else library.splice(i, 1);
    }
    await saveLibrary(library);
  }).catch(e => console.warn('보관함 기록 실패', e));
  return libraryQueue;
}
const THUMB_MAX = 20_000;

// 저장 공간이 모자라면 오래된 절반의 미리보기를 지우고 한 번 더 시도
async function saveLibrary(library) {
  try { await chrome.storage.local.set({ library }); } catch {
    const half = Math.floor(library.length / 2);
    await chrome.storage.local.set({ library: library.map((x, i) => i >= half ? { ...x, thumb: '' } : x) });
  }
}

// 보관함 기록과 브라우저의 다운로드 항목이 같은 저장인지: 이 확장이 시작했고, 시작 시각이 기록 시각과 가깝다
function sameDownload(entry, item) {
  return !!item && item.byExtensionId === chrome.runtime.id && Math.abs(Date.parse(item.startTime) - entry.ts) < 10 * 60_000;
}

// 같은 이름이 있으면 브라우저가 "제목 (1).mp4"처럼 바꾸므로, 실제 저장된 이름으로 맞춘다 (설정한 하위 폴더는 유지)
function finalName(requested, actualPath) {
  if (!actualPath) return requested;
  const dir = requested.includes('/') ? requested.slice(0, requested.lastIndexOf('/') + 1) : '';
  return dir + actualPath.split(/[\\/]/).pop();
}

// 저장 이름이 정해지거나 저장이 실패했을 때 보관함 기록을 실제와 맞춘다
chrome.downloads.onChanged.addListener(d => {
  const failed = d.state?.current === 'interrupted';
  if (!d.filename?.current && !failed) return;
  libraryQueue = libraryQueue.then(async () => {
    const { library = [] } = await chrome.storage.local.get('library');
    if (!library.some(x => x.downloadId === d.id)) return;
    // 다운로드 기록을 지우면 브라우저가 번호를 다시 쓰므로, 이 확장이 방금 시작한 저장이 맞는지 확인한다
    const [item] = await chrome.downloads.search({ id: d.id });
    const mine = x => x.downloadId === d.id && sameDownload(x, item);
    if (!library.some(mine)) return;
    const next = failed ? library.filter(x => !mine(x))
      : library.map(x => mine(x) ? { ...x, filename: finalName(x.filename, d.filename.current) } : x);
    await chrome.storage.local.set({ library: next });
  }).catch(e => console.warn('보관함 수정 실패', e));
});

// 백업 파일의 기록을 검사해 들여온다. 모양이 이상한 값은 버리고, 그림은 데이터 주소(data:image)만 받는다.
function importLibrary(list) {
  let added = 0;
  libraryQueue = libraryQueue.then(async () => {
    if (!Array.isArray(list)) throw new Error('보관함 백업 파일이 아닙니다.');
    const { library = [] } = await chrome.storage.local.get('library');
    const have = new Set(library.map(x => x.id));
    const str = (x, n) => String(x ?? '').slice(0, n);
    const fresh = new Set();
    for (const x of list.slice(0, LIBRARY_HARD_MAX)) {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || have.has(str(x.id, 64))) continue;
      const m = x.meta && typeof x.meta === 'object' ? x.meta : null;
      library.push({
        id: str(x.id, 64), ts: Number(x.ts) || Date.now(), kind: str(x.kind, 40), title: str(x.title, 200),
        pageUrl: /^https?:/.test(x.pageUrl || '') ? str(x.pageUrl, 2000) : '', site: str(x.site, 100), filename: str(x.filename, 300),
        downloadId: null, thumb: /^data:image\/(jpeg|png|webp);base64,/.test(x.thumb || '') && x.thumb.length <= THUMB_MAX ? x.thumb : '',
        memo: str(x.memo, 500), tags: str(x.tags, 200), board: str(x.board, 40).trim(), rating: Math.max(0, Math.min(5, Math.round(Number(x.rating) || 0))),
        ...(m ? { meta: { author: str(m.author, 80), published: str(m.published, 40), caption: str(m.caption, 600),
          hashtags: (Array.isArray(m.hashtags) ? m.hashtags : []).map(h => str(h, 40)).slice(0, 20), views: Number(m.views) || 0, likes: Number(m.likes) || 0 } } : {}),
      });
      have.add(str(x.id, 64)); fresh.add(str(x.id, 64));
    }
    library.sort((a, b) => b.ts - a.ts);
    // 한도를 넘으면 저장할 때와 같은 규칙으로: 표시(보드·별점·메모·태그)가 없는 오래된 기록부터 뺀다
    const marked = x => x.board || x.rating || x.memo || x.tags;
    while (library.length > LIBRARY_MAX) {
      let i = library.length - 1;
      while (i > 0 && marked(library[i])) i--;
      if (i === 0) { if (library.length > LIBRARY_HARD_MAX) library.pop(); else break; }
      else library.splice(i, 1);
    }
    added = library.filter(x => fresh.has(x.id)).length; // 실제로 남은 것만 센다
    await saveLibrary(library);
  });
  const p = libraryQueue.then(() => ({ ok: true, added }));
  libraryQueue = libraryQueue.catch(e => console.warn('보관함 가져오기 실패', e));
  return p;
}

function updateLibrary(id, change) {
  libraryQueue = libraryQueue.then(async () => {
    const { library = [] } = await chrome.storage.local.get('library');
    const next = id == null ? [] : change === null ? library.filter(x => x.id !== id)
      : library.map(x => x.id === id ? { ...x,
        memo: String(change.memo ?? x.memo).slice(0, 500), tags: String(change.tags ?? x.tags).slice(0, 200),
        board: String(change.board ?? x.board ?? '').trim().slice(0, 40),
        rating: Math.max(0, Math.min(5, Math.round(Number(change.rating ?? x.rating ?? 0)) || 0)) } : x);
    await chrome.storage.local.set({ library: next });
  }).catch(e => console.warn('보관함 수정 실패', e));
  return libraryQueue;
}

// ── 스트리밍 받기: 다운로드 목록 ──────────────────────────────────
// 실제 받기는 숨겨진 페이지(stream.js)가 하고, 여기서는 목록(대기열)·진행 표시·저장을 맡는다.
// 목록은 session 저장소(hlsJobs)에 두어 배경이 잠들었다 깨어나도 이어진다. 탭을 옮기거나 페이지를 바꿔도 계속 받는다.
// 한 번에 하나씩 받고, 끝나면 다음 것을 자동으로 시작한다.
const HLS_SILENT_MS = 3 * 60_000; // 숨겨진 페이지는 10초마다 소식을 보낸다. 이만큼 끊기면 죽은 것으로 본다.
const JOBS_KEEP = 30;              // 목록에 남겨 두는 끝난 항목 수
const ACTIVE = new Set(['queued', 'running']);
let hlsStarting = false;
let hlsProbing = 0;
// 목록은 여러 소식이 거의 동시에 오므로 한 줄로 세워 차례대로 고친다
let hlsQueue = Promise.resolve();
let lastJobs = []; // 읽기·쓰기가 실패해도 빈 목록으로 보이지 않게 마지막으로 알던 목록
const jobsEdit = fn => (hlsQueue = hlsQueue.then(async () => {
  const { hlsJobs = [] } = await chrome.storage.session.get('hlsJobs');
  const next = await fn(hlsJobs);
  if (next) await chrome.storage.session.set({ hlsJobs: next });
  return (lastJobs = next || hlsJobs);
}).catch(e => { console.warn('스트리밍 목록 기록 실패', e); return lastJobs; }));
const isLiveJob = j => j.live || j.liveHint;
const failed = (job, error) => ({ ...job, state: 'error', error, endedAt: Date.now() });

// 지금의 목록. 받는 중이라고 적혀 있어도 숨겨진 페이지가 사라졌거나 소식이 오래 끊겼으면(메모리 부족으로 죽은 경우 등)
// 실패로 바꿔 적고 다음 항목으로 넘어간다.
async function jobsNow() {
  let changed = false;
  const jobs = await jobsEdit(async list => {
    if (hlsStarting || !list.some(j => j.state === 'running')) return;
    const doc = await chrome.offscreen.hasDocument();
    const dead = list.filter(j => {
      if (j.state !== 'running') return false;
      const silent = Date.now() - (j.beat || j.startedAt);
      return (silent > 5000 && !doc) || silent >= HLS_SILENT_MS;
    });
    if (!dead.length) return;
    for (const j of dead) chrome.runtime.sendMessage({ type: 'offscreen-hls-cancel', job: j.id }).catch(() => {});
    changed = true;
    return list.map(j => (dead.includes(j) ? failed(j, '받는 도중 멈췄습니다. 다시 시도해 주세요. 영상이 아주 크면 위의 녹화를 이용해 주세요.') : j));
  });
  if (changed) pump();
  return jobs;
}

// 받을 목록: 팝업이 주소를 직접 준 경우(주소로 받기)는 그것, 아니면 그 탭에서 본 목록들
async function hlsLists({ tabId, urls }) {
  await streamTabsReady;
  if (Array.isArray(urls) && urls.length) {
    const list = urls.filter(u => typeof u === 'string' && /^https?:/i.test(u)).slice(0, 4).map(url => ({ url, kind: /\.mpd(\?|$)/i.test(url) ? 'dash' : '', from: '' }));
    if (!list.length) throw new Error('http 또는 https로 시작하는 주소를 넣어 주세요.');
    return list;
  }
  const list = streamTabs.get(tabId)?.hls || [];
  if (!list.length) throw new Error('받을 스트리밍 영상을 찾지 못했습니다. 영상을 한 번 재생한 뒤 다시 눌러 주세요.');
  return list;
}
// 조각 서버에 알려 줄 "어느 페이지에서 왔는지". 끼워 넣은 플레이어(프레임)가 불러온 영상이면 그 프레임의 출처, 아니면 탭의 페이지.
function originOf(list, pageUrl) {
  let origin = list[list.length - 1].from || '';
  if (!origin) { try { origin = new URL(pageUrl).origin; } catch {} }
  return /^https?:\/\//.test(origin) ? origin : '';
}

// ── Referer·Origin 규칙 ──
// 조각 서버가 Referer·Origin을 확인하는 경우가 많다. 숨겨진 페이지가 받으려는 서버(호스트)를 하나씩 알려 주면,
// 그 서버로 가는 이 확장의 요청에만 원래 페이지 주소를 붙인다. 다른 요청(새 버전 확인, 다른 사이트의 원본 확인 등)은 건드리지 않는다.
// 출처(origin)마다 규칙 하나: { [origin]: { id, hosts: [], owners: { 호스트: 그 호스트를 등록한 작업 번호 } } }
// 규칙은 하위 도메인까지 적용되므로, 한쪽이 다른 쪽의 하위 도메인이어도 같은 서버로 본다
const sameHost = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
let ruleQueue = Promise.resolve();
const ruleFor = (origin, r) => ({ id: r.id, priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: origin + '/' }, { header: 'origin', operation: 'set', value: origin }] },
  condition: { requestDomains: r.hosts, initiatorDomains: [chrome.runtime.id], tabIds: [-1], excludedRequestDomains: TIKTOK_CDN, resourceTypes: ['xmlhttprequest', 'other'] } });
function allowHost(origin, host, job = '') {
  let blocked = false;
  ruleQueue = ruleQueue.then(async () => {
    if (!/^https?:\/\//.test(origin || '') || !/^[a-z0-9.-]+$/i.test(host || '')) return;
    host = host.toLowerCase();
    const [{ hlsRules = {} }, { hlsJobs = [] }] = await Promise.all([chrome.storage.session.get('hlsRules'), chrome.storage.session.get('hlsJobs')]);
    const touched = new Set();
    // 같은 서버를 다른 페이지가 쓰고 있었으면 지금 것으로 옮긴다.
    // 받는 중인 다른 작업이 그 서버를 쓰고 있으면, 먼저 시작한 작업이 이긴다:
    //  - 묻는 쪽이 나중에 시작했거나 화질 확인이면 → 옮기지 않고 "함께 받을 수 없음"으로 답한다
    //  - 묻는 쪽이 먼저 시작했으면(예: 생방송의 서버가 도중에 바뀜) → 서버를 가져오고, 나중에 시작한 작업을 목록으로 되돌린다
    const me = hlsJobs.find(j => j.id === job && j.state === 'running');
    const myStart = me?.startedAt ?? Infinity;
    const yieldIds = [];
    for (const [o, r] of Object.entries(hlsRules)) {
      if (o === origin) continue;
      const clash = r.hosts.filter(h => sameHost(h, host));
      if (!clash.length) continue;
      // 그 서버를 실제로 등록한 작업 중 아직 받는 중인 것만 주인으로 본다 (끝난 작업·화질 확인이 남긴 것은 주인이 아니다)
      const ownerIds = new Set(clash.map(h => r.owners?.[h]).filter(Boolean));
      const owners = hlsJobs.filter(j => j.state === 'running' && j.id !== job && ownerIds.has(j.id));
      if (owners.some(j => (j.startedAt ?? 0) <= myStart)) { blocked = true; return; }
      yieldIds.push(...owners.map(j => j.id));
      r.hosts = r.hosts.filter(h => !clash.includes(h));
      for (const h of clash) delete r.owners?.[h];
      touched.add(o);
    }
    for (const id of yieldIds) chrome.runtime.sendMessage({ type: 'offscreen-hls-yield', job: id }).catch(() => {});
    let r = hlsRules[origin];
    if (!r) { const used = new Set(Object.values(hlsRules).map(x => x.id)); let id = 10; while (used.has(id)) id++; r = hlsRules[origin] = { id, hosts: [], owners: {} }; }
    r.owners ||= {};
    if (job && job !== 'probe') r.owners[host] = job; // 받는 작업이 쓰는 서버로 표시 (화질 확인은 표시하지 않는다)
    if (!r.hosts.includes(host)) { r.hosts.push(host); touched.add(origin); }
    else if (job && job !== 'probe') await chrome.storage.session.set({ hlsRules }); // 주인 표시만 바뀐 경우
    if (!touched.size) return;
    const removeRuleIds = [], addRules = [];
    for (const o of touched) {
      removeRuleIds.push(hlsRules[o].id);
      if (hlsRules[o].hosts.length) addRules.push(ruleFor(o, hlsRules[o])); else delete hlsRules[o];
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    await chrome.storage.session.set({ hlsRules });
  }).catch(e => console.warn('Referer 규칙 등록 실패', e));
  return ruleQueue.then(() => ({ busy: blocked }));
}
// 받는 것도, 알아보는 것도 없으면 규칙을 모두 거둔다
function dropRulesIfIdle() {
  ruleQueue = ruleQueue.then(async () => {
    if (hlsStarting || hlsProbing) return;
    const { hlsJobs = [] } = await chrome.storage.session.get('hlsJobs');
    if (hlsJobs.some(j => ACTIVE.has(j.state))) return;
    const { hlsRules = {} } = await chrome.storage.session.get('hlsRules');
    const ids = [2, ...Object.values(hlsRules).map(r => r.id)]; // 2: 예전 버전이 쓰던 규칙
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    await chrome.storage.session.set({ hlsRules: {} });
  }).catch(() => {});
  return ruleQueue;
}

// 받기 전에 고를 수 있는 화질·소리를 알아본다. 다른 영상을 받는 중에도 할 수 있다.
async function hlsProbe(msg) {
  const list = await hlsLists(msg);
  hlsProbing++;
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: 'offscreen-hls-probe', urls: list, origin: originOf(list, msg.pageUrl), hint: Number(msg.hint) > 0 ? Number(msg.hint) : 0 });
    return res || { ok: false, error: '목록을 읽지 못했습니다.' };
  } finally {
    hlsProbing--;
    dropRulesIfIdle();
    maybeCloseOffscreen();
  }
}

// 목록에 더한다. 받는 중인 것이 없으면 바로 시작한다.
async function hlsEnqueue(msg) {
  const list = await hlsLists(msg);
  const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state: 'queued', createdAt: Date.now(),
    tabId: msg.tabId, title: String(msg.title || '').slice(0, 200), pageUrl: msg.pageUrl, incognito: !!tab?.incognito,
    urls: list, origin: originOf(list, msg.pageUrl), hint: Number(msg.hint) > 0 ? Number(msg.hint) : 0,
    variant: typeof msg.variant === 'string' ? msg.variant : '', audio: typeof msg.audio === 'string' ? msg.audio : '',
    variantLabel: typeof msg.variantLabel === 'string' ? msg.variantLabel.slice(0, 40) : '', liveHint: !!msg.live,
    direct: !!msg.urls?.length, done: 0, total: 0, bytes: 0, seconds: 0, live: false, quality: '',
  };
  let position = 0;
  await jobsEdit(list0 => {
    // 끝난 항목이 너무 많으면 오래된 것부터 목록에서 뺀다 (파일은 그대로)
    let next = [...list0, job];
    while (next.length > JOBS_KEEP && next.some(j => !ACTIVE.has(j.state))) next.splice(next.findIndex(j => !ACTIVE.has(j.state)), 1);
    position = next.filter(j => ACTIVE.has(j.state)).length;
    return next;
  });
  await pump();
  // 바로 시작했는지(생방송과 함께 받는 경우 포함), 몇 번째로 기다리는지 알려 준다
  const now = (await jobsEdit(() => null)).find(j => j.id === job.id);
  return { ok: true, id: job.id, position, started: now?.state === 'running' };
}

// 받는 중인 것이 없으면 대기 중인 다음 항목을 시작한다
let pumping = Promise.resolve();
function pump() {
  pumping = pumping.then(async () => {
    let job = null;
    await jobsEdit(list => {
      // 보통은 한 번에 하나. 받는 중인 것이 생방송뿐이면, 생방송이 아닌 영상 하나를 함께 받는다
      // (생방송은 정지할 때까지 끝나지 않으므로, 뒤에 더한 영상이 몇 시간씩 기다리지 않게).
      const run = list.filter(j => j.state === 'running');
      let next = null;
      if (!run.length) next = list.find(j => j.state === 'queued');
      else if (run.length === 1 && isLiveJob(run[0])) next = list.find(j => j.state === 'queued' && !isLiveJob(j) && !j.afterLive);
      if (!next) return;
      job = { ...next, state: 'running', startedAt: Date.now(), beat: Date.now() };
      return list.map(j => (j.id === next.id ? job : j));
    });
    if (!job) { dropRulesIfIdle(); maybeCloseOffscreen(); return; }
    hlsStarting = true;
    try {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ type: 'offscreen-hls', job: job.id, urls: job.urls, origin: job.origin, hint: job.hint, variant: job.variant, audio: job.audio });
    } catch (e) {
      await jobsEdit(list => list.map(j => (j.id === job.id ? failed(j, e.message || '시작하지 못했습니다.') : j)));
      hlsStarting = false;
      pump();
      return;
    }
    hlsStarting = false;
  }).catch(e => console.warn('다음 스트리밍 시작 실패', e));
  return pumping;
}

// 정지 후 저장: 지금까지 받은 것만으로 파일을 만든다 (생방송은 여기서 끝난다). 대기 중인 항목이면 목록에서 취소한다.
async function hlsStop(id) {
  const jobs = await jobsNow();
  const j = jobs.find(x => x.id === id);
  if (j?.state !== 'running') return hlsCancel(id);
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-hls-stop', job: id }).catch(() => null);
  if (!res?.active) return hlsCancel(id);
}
async function hlsCancel(id) {
  const jobs = await jobsNow();
  const j = jobs.find(x => x.id === id);
  if (!j || !ACTIVE.has(j.state)) return;
  if (j.state === 'running') {
    const res = await chrome.runtime.sendMessage({ type: 'offscreen-hls-cancel', job: id }).catch(() => null);
    if (res?.active) return; // 숨겨진 페이지가 "취소됨" 소식을 보내 오면 hlsDone에서 정리된다
  }
  await jobsEdit(list => list.map(x => (x.id === id && ACTIVE.has(x.state) ? { ...x, state: 'canceled', endedAt: Date.now() } : x)));
  pump();
}
// 끝난 항목(저장함·실패·취소)을 목록에서 지운다. 파일은 그대로 남는다.
function hlsClear() {
  return jobsEdit(list => list.filter(j => ACTIVE.has(j.state)));
}
async function hlsProgress({ job, done, total, bytes, seconds, live, quality }) {
  let becameLive = false;
  await jobsEdit(list => {
    const j = list.find(x => x.id === job);
    if (j?.state !== 'running') return;
    becameLive = !!live && !j.live;
    return list.map(x => (x === j ? { ...x, done, total, bytes, seconds: seconds || 0, live: !!live, quality: quality || x.quality, beat: Date.now() } : x));
  });
  if (becameLive) pump(); // 생방송인 것이 드러났으면, 기다리던 다른 영상을 함께 받기 시작한다
}
async function hlsDone(res) {
  let blobUrl = res.ok ? res.url : '';
  await jobsEdit(async list => {
    const j = list.find(x => x.id === res.job);
    if (!j || j.state !== 'running') return; // 지난 작업(취소·중단 처리된 것)의 소식
    let next;
    // 함께 받을 수 없었던 것(같은 영상 서버를 쓰는 다른 작업이 있음): 목록에 되돌려 두고, 앞 작업이 끝난 뒤 받는다
    if (!res.ok && res.slotBusy) next = { ...j, state: 'queued', afterLive: true, waitReason: res.slotReason === 'memory' ? 'memory' : 'server',
      restarted: !!(j.done || j.bytes), done: 0, total: 0, bytes: 0, seconds: 0 };
    else if (!res.ok) next = /취소/.test(res.error || '') ? { ...j, state: 'canceled', endedAt: Date.now() } : failed(j, res.error || '받지 못했습니다.');
    else {
      try {
        const filename = await buildName(j.title, j.pageUrl, res.audioOnly ? 'm4a' : 'mp4', { suffix: res.partial ? '일부' : '' });
        const id = await safeDownload(res.url, filename);
        blobUrl = '';
        offscreenBlobs.set(id, res.url); // 저장이 끝나면 숨겨진 페이지가 잡고 있는 데이터(디스크의 임시 파일 포함)를 놓아 준다
        logSave({ kind: res.live ? '생방송 받기' : '스트리밍 다운로드', title: j.title, pageUrl: j.pageUrl, filename, downloadId: id, thumb: '', incognito: j.incognito });
        next = { ...j, state: 'done', size: res.size, seconds: res.seconds, quality: res.quality, partial: !!res.partial, live: !!res.live,
          note: typeof res.note === 'string' ? res.note : '', downloadId: id, endedAt: Date.now() };
      } catch (e) { next = failed(j, e.message); }
    }
    return list.map(x => (x === j ? next : x));
  });
  // 저장으로 이어지지 않은 결과물은 바로 놓아 준다
  if (blobUrl) chrome.runtime.sendMessage({ type: 'offscreen-revoke', url: blobUrl }).catch(() => {});
  pump();
}
