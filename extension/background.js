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
    // documentId: 이 파일을 불러온 문서. 뒤로 가기로 예전 페이지가 되살아났을 때 다른 페이지의 파일이 섞이지 않게 팝업에서 걸러낸다
    list.unshift({ url: details.url, type: type || 'video/mp4', size, ts: Date.now(), documentId: details.documentId || '' });
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

async function clearTab(tabId) {
  const media = await load();
  if (!media[tabId]) return;
  delete media[tabId];
  save(media);
  updateBadge(tabId);
}

chrome.tabs.onRemoved.addListener(tabId => { clearTab(tabId); setVideoRec(tabId, null, false); });
// 영상 녹화 상태는 여기서 지우지 않는다: 파일 다운로드 링크처럼 페이지가 바뀌지 않는 이동 요청도 있기 때문.
// 실제로 페이지를 떠날 때는 content.js가 알려준다(pagehide).
// 감지된 파일 목록은 새 페이지가 실제로 열릴 때만 비운다. 파일 다운로드 링크(첨부), 내용 없는 응답(204),
// 미리 불러오기(prerender)는 지금 페이지를 바꾸지 않으므로 건드리지 않는다.
chrome.webRequest.onHeadersReceived.addListener(
  d => {
    if (d.tabId < 0 || d.frameId !== 0 || (d.documentLifecycle && d.documentLifecycle !== 'active')) return;
    if (d.statusCode < 200 || d.statusCode >= 300 || d.statusCode === 204 || d.statusCode === 205) return;
    if (/attachment/i.test(header(d.responseHeaders, 'content-disposition'))) return;
    clearTab(d.tabId);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders']
);

// 확장 자체 화면(팝업·보관함·녹화 창·숨겨진 페이지)에서만 받는 요청. 웹페이지에 들어간 content.js가 보낸 것은 거절한다.
const EXT_ONLY = new Set(['tabrec-start', 'tabrec-stop', 'tabrec-ended', 'download', 'shot-tab', 'log-save', 'library-update']);
const SAVE_EXTS = new Set(['mp4', 'webm', 'mov', 'png']);

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
  if (msg.type === 'save-video-url') {
    // 페이지의 "저장" 버튼(content.js)이 보낸 원본 영상 주소 저장. 영상 파일 형식만 허용한다.
    // 주소가 영상 파일(.mp4 등)이거나, 그 탭에서 실제로 영상으로 받아진 것이 확인된 주소여야 한다.
    let u = null;
    try { u = new URL(msg.url); } catch {}
    if (!_sender.tab || !u || !/^https?:$/.test(u.protocol)) { sendResponse({ ok: false, error: '잘못된 요청입니다.' }); return; }
    load().then(media => {
        const seen = (media[_sender.tab.id] || []).find(f => f.url === msg.url);
        const byPath = u.pathname.match(/\.(mp4|webm|mov)$/i)?.[1].toLowerCase();
        const byType = seen && { 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mp4': 'mp4' }[seen.type];
        const ext = byPath || byType;
        if (!ext) throw new Error('영상 파일로 확인되지 않은 주소입니다.');
        return buildName(msg.title, _sender.tab.url, ext);
      })
      .then(async filename => {
        const id = await download(msg.url, filename);
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
        logSave({ kind: msg.kind || '영상 녹화', title: msg.title, pageUrl: _sender.tab?.url || '', filename, downloadId: id, thumb: msg.thumb, incognito: _sender.tab?.incognito });
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
    return await safeDownload(res.url, filename);
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
let tabRecStarting = 0;
async function maybeCloseOffscreen() {
  if (fetchesInFlight > 0 || creatingOffscreen || tabRecStarting) return;
  const [{ tabRec }, active] = await Promise.all([
    chrome.storage.session.get('tabRec'),
    chrome.downloads.search({ state: 'in_progress' }),
  ]);
  if (tabRec || tabRecStarting || fetchesInFlight > 0 || active.some(d => d.url.startsWith(EXT_BLOB))) return;
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
let libraryQueue = Promise.resolve();
function logSave(entry) {
  if (entry.incognito) return libraryQueue; // 시크릿 창에서 저장한 것은 기록하지 않는다
  libraryQueue = libraryQueue.then(async () => {
    const naming = await getNaming();
    if (!naming.library) return;
    const { library = [] } = await chrome.storage.local.get('library');
    const [d] = entry.downloadId != null ? await chrome.downloads.search({ id: entry.downloadId }) : [];
    library.unshift({
      id: crypto.randomUUID(), ts: Date.now(), kind: entry.kind || '', title: (entry.title || '').slice(0, 200),
      pageUrl: /^https?:/.test(entry.pageUrl || '') ? entry.pageUrl : '', site: siteOf(entry.pageUrl),
      filename: finalName(entry.filename || '', d?.filename), downloadId: entry.downloadId ?? null,
      // 미리보기는 보통 2~10KB. 저장 공간(브라우저 한도 약 10MB)을 넘지 않게 큰 것은 버린다
      thumb: (entry.thumb || '').length <= THUMB_MAX ? entry.thumb || '' : '', memo: '', tags: '',
      board: String(naming.board || '').slice(0, 40), rating: 0,
    });
    library.length = Math.min(library.length, LIBRARY_MAX);
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
