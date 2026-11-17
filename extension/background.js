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
    condition: { requestDomains: TIKTOK_CDN, tabIds: [-1], resourceTypes: ['xmlhttprequest', 'other'] },
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
    if (details.statusCode !== 200 && details.statusCode !== 206) return; // 리다이렉트·오류 응답 제외
    const type = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    const url = new URL(details.url);
    const looksVideo = /^video\/(mp4|webm|quicktime)$/.test(type) || /\.(mp4|webm|mov)$/i.test(url.pathname);
    if (!looksVideo || isSegmentUrl(url)) return;
    const size = totalSize(details.responseHeaders);
    const sizeKnown = !!(header(details.responseHeaders, 'content-range') || header(details.responseHeaders, 'content-length'));
    if (sizeKnown && size < 100 * 1024) return; // 빈 응답, 아이콘/미리보기 같은 아주 작은 파일 제외

    const media = await load();
    const list = (media[details.tabId] ||= []);
    if (list.some(m => m.url === details.url)) return;
    list.unshift({ url: details.url, type: type || 'video/mp4', size, ts: Date.now() });
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
  if (rec) chrome.action.setBadgeBackgroundColor({ tabId, color: '#e5484d' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: rec ? 'REC' : n ? String(n) : '' }).catch(() => {});
}

async function clearTab(tabId) {
  const media = await load();
  if (!media[tabId]) return;
  delete media[tabId];
  save(media);
  updateBadge(tabId);
}

chrome.tabs.onRemoved.addListener(tabId => { clearTab(tabId); setVideoRec(tabId, null, false); });
chrome.webRequest.onBeforeRequest.addListener(
  d => { if (d.tabId >= 0) { clearTab(d.tabId); setVideoRec(d.tabId, null, false); } },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  if (msg.type === 'save-blob') {
    buildName(msg.title, _sender.tab?.url || _sender.url, msg.ext, { suffix: msg.suffix })
      .then(async filename => {
        const id = await chrome.downloads.download({ url: msg.url, filename, saveAs: false });
        logSave({ kind: msg.kind || '영상 녹화', title: msg.title, pageUrl: _sender.tab?.url || '', filename, downloadId: id, thumb: msg.thumb });
        return id;
      })
      .then(id => sendResponse({ ok: true, id }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'shot-tab') {
    shotTab(msg).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'log-save') { logSave(msg.entry); return; }
  if (msg.type === 'library-update') { updateLibrary(msg.id, msg.change).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'getMedia') {
    load().then(media => sendResponse(media[msg.tabId] || []));
    return true;
  }
  if (msg.type === 'download') {
    buildName(msg.title, msg.pageUrl, msg.ext)
      .then(async filename => {
        const id = await download(msg.url, filename);
        logSave({ kind: '원본 다운로드', title: msg.title, pageUrl: msg.pageUrl, filename, downloadId: id, thumb: msg.thumb });
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
  if (!isTikTokCdn(url)) return chrome.downloads.download({ url, filename, saveAs: false });
  // 틱톡: 다운로드 API 요청에는 Referer를 붙일 수 없어서, 숨겨진 페이지에서 받아 저장
  fetchesInFlight++;
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: 'offscreen-fetch', url });
    if (!res?.ok) throw new Error(res?.error || '받기 실패');
    // 저장이 시작된 뒤(in_progress)에 카운트를 내려야 숨겨진 페이지가 먼저 닫히지 않는다
    return await chrome.downloads.download({ url: res.url, filename, saveAs: false });
  } finally {
    fetchesInFlight--;
    maybeCloseOffscreen();
  }
}

// 동시에 두 번 불려도 문서를 한 번만 만들도록 진행 중인 생성 작업을 공유
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS', 'USER_MEDIA'], justification: '영상 파일 저장 및 탭 녹화',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

// 숨겨진 페이지는 받는 중인 파일, 탭 녹화, 확장이 만든 임시 파일(blob)의 저장이 모두 끝났을 때만 닫는다.
// 저장 건수를 세지 않고 매번 실제 상태를 확인하므로, 화면 녹화 저장 등이 섞여도 어긋나지 않는다.
async function maybeCloseOffscreen() {
  if (fetchesInFlight > 0 || creatingOffscreen) return;
  const [{ tabRec }, active] = await Promise.all([
    chrome.storage.session.get('tabRec'),
    chrome.downloads.search({ state: 'in_progress' }),
  ]);
  if (tabRec || fetchesInFlight > 0 || active.some(d => d.url.startsWith(EXT_BLOB))) return;
  if (await chrome.offscreen.hasDocument()) chrome.offscreen.closeDocument().catch(() => {});
}

chrome.downloads.onChanged.addListener(d => {
  if (d.state && d.state.current !== 'in_progress') maybeCloseOffscreen();
});

// ── 탭 전체 녹화 ─────────────────────────────────────────
// 영상 요소 녹화가 막히는 사이트에서도 탭 화면+소리를 그대로 녹화한다.
// (DRM 영상은 브라우저가 검은 화면으로 내보내므로 녹화되지 않음)
async function startTabRecording(tabId, streamId, title, pageUrl) {
  const filename = await buildName(title, pageUrl); // 확장자는 녹화가 끝난 뒤 붙는다
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (tabRec) throw new Error('이미 다른 탭을 녹화 중입니다. 먼저 정지해 주세요.');
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-tabrec-start', streamId, filename });
  if (!res?.ok) throw new Error(res?.error || '탭 녹화를 시작하지 못했습니다.');
  // 보관함용 미리보기: 녹화를 시작한 탭이 지금 보이는 탭이면 화면을 한 장 찍어 둔다
  let thumb = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) thumb = await makeThumb(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 }));
  } catch {}
  await chrome.storage.session.set({ tabRec: { tabId, startedAt: Date.now(), title, pageUrl, thumb } });
  updateBadge(tabId);
  openTabRecControl(tabId);
}

// 녹화 중 "정지 후 저장" 버튼이 항상 보이도록 작은 조절 창을 브라우저 창 오른쪽 아래에 띄운다.
// (별도 창이라 탭 녹화 화면에는 찍히지 않음)
async function openTabRecControl(tabId) {
  const W = 320, H = 200;
  const opts = { url: 'tabctl.html', type: 'popup', width: W, height: H, focused: true };
  try {
    const { windowId } = await chrome.tabs.get(tabId);
    const w = await chrome.windows.get(windowId);
    if (w.state === 'normal' || w.state === 'maximized') {
      opts.left = Math.max(0, w.left + w.width - W - 24);
      opts.top = Math.max(0, w.top + w.height - H - 24);
    }
  } catch {}
  await chrome.windows.create(opts).catch(() => chrome.windows.create({ url: 'tabctl.html', type: 'popup', width: W, height: H }));
}

async function stopTabRecording() {
  // 실제 정리는 숨겨진 페이지가 보내는 'tabrec-ended'에서 처리
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-tabrec-stop' }).catch(() => null);
  if (!res?.recording) onTabRecEnded({}); // 숨겨진 페이지가 이미 없거나 녹화 중이 아니면 상태만 정리
}

async function onTabRecEnded({ url, filename }) {
  // 저장을 먼저 시작한 뒤 녹화 상태를 지워야, 그 사이 숨겨진 페이지가 닫혀 임시 파일이 사라지지 않는다
  const id = url ? await chrome.downloads.download({ url, filename, saveAs: false }).catch(e => console.warn('탭 녹화 저장 실패', e)) : null;
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (id != null) logSave({ kind: '탭 녹화', title: tabRec?.title, pageUrl: tabRec?.pageUrl, filename, downloadId: id, thumb: tabRec?.thumb });
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
  if (changes.screenRec) for (const tabId of Object.keys(await load())) updateBadge(Number(tabId));
});
chrome.runtime.onStartup.addListener(refreshAction);
chrome.runtime.onInstalled.addListener(refreshAction);

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
  let dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  if (rect) {
    const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const dpr = vw ? img.width / vw : 1; // 찍힌 그림과 페이지 좌표의 비율 (화면 배율·확대/축소 반영)
    const x = Math.max(0, Math.round(rect.x * dpr)), y = Math.max(0, Math.round(rect.y * dpr));
    const w = Math.min(img.width - x, Math.round(rect.w * dpr)), h = Math.min(img.height - y, Math.round(rect.h * dpr));
    if (w > 8 && h > 8) {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      dataUrl = await blobToDataUrl(await c.convertToBlob({ type: 'image/png' }));
    }
  }
  const filename = await buildName(title, pageUrl, 'png', { suffix });
  const id = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  logSave({ kind: '장면 캡처', title, pageUrl, filename, downloadId: id, thumb: await makeThumb(dataUrl).catch(() => '') });
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
let libraryQueue = Promise.resolve();
function logSave(entry) {
  libraryQueue = libraryQueue.then(async () => {
    if (!(await getNaming()).library) return;
    const { library = [] } = await chrome.storage.local.get('library');
    library.unshift({
      id: crypto.randomUUID(), ts: Date.now(), kind: entry.kind || '', title: (entry.title || '').slice(0, 200),
      pageUrl: /^https?:/.test(entry.pageUrl || '') ? entry.pageUrl : '', site: siteOf(entry.pageUrl),
      filename: entry.filename || '', downloadId: entry.downloadId ?? null,
      thumb: (entry.thumb || '').length < 60_000 ? entry.thumb || '' : '', memo: '', tags: '',
    });
    library.length = Math.min(library.length, LIBRARY_MAX);
    await chrome.storage.local.set({ library });
  }).catch(e => console.warn('보관함 기록 실패', e));
  return libraryQueue;
}

function updateLibrary(id, change) {
  libraryQueue = libraryQueue.then(async () => {
    const { library = [] } = await chrome.storage.local.get('library');
    const next = id == null ? [] : change === null ? library.filter(x => x.id !== id)
      : library.map(x => x.id === id ? { ...x, memo: String(change.memo ?? x.memo).slice(0, 500), tags: String(change.tags ?? x.tags).slice(0, 200) } : x);
    await chrome.storage.local.set({ library: next });
  }).catch(e => console.warn('보관함 수정 실패', e));
  return libraryQueue;
}
