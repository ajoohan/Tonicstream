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
    const type = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    const url = new URL(details.url);
    const looksVideo = /^video\/(mp4|webm|quicktime)$/.test(type) || /\.(mp4|webm|mov)$/i.test(url.pathname);
    if (!looksVideo || isSegmentUrl(url)) return;
    const size = totalSize(details.responseHeaders);
    if (size && size < 100 * 1024) return; // 아이콘/미리보기 같은 아주 작은 파일 제외

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

// 배지: 탭 녹화 중이면 REC, 아니면 감지된 원본 파일 개수
async function updateBadge(tabId) {
  const [media, { tabRec }] = await Promise.all([load(), chrome.storage.session.get('tabRec')]);
  const rec = tabRec?.tabId === tabId;
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

chrome.tabs.onRemoved.addListener(clearTab);
chrome.webRequest.onBeforeRequest.addListener(
  d => { if (d.tabId >= 0) clearTab(d.tabId); },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'tabrec-start') {
    startTabRecording(msg.tabId, msg.streamId, msg.filename)
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
  if (msg.type === 'getMedia') {
    load().then(media => sendResponse(media[msg.tabId] || []));
    return true;
  }
  if (msg.type === 'download') {
    download(msg.url, msg.filename)
      .then(id => sendResponse({ ok: true, id }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

const isTikTokCdn = url => {
  try { const h = new URL(url).hostname; return TIKTOK_CDN.some(d => h === d || h.endsWith('.' + d)); } catch { return false; }
};

let offscreenJobs = 0; // 숨겨진 페이지에서 진행 중인 받기/저장 작업 수

async function download(url, filename) {
  if (!isTikTokCdn(url)) return chrome.downloads.download({ url, filename, saveAs: false });
  // 틱톡: 다운로드 API 요청에는 Referer를 붙일 수 없어서, 숨겨진 페이지에서 받아 저장
  await ensureOffscreen();
  offscreenJobs++;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'offscreen-fetch', url });
    if (!res?.ok) throw new Error(res?.error || '받기 실패');
    offscreenJobs++; // 아래 저장이 끝날 때 downloads.onChanged에서 감소
    return await chrome.downloads.download({ url: res.url, filename, saveAs: false });
  } finally {
    offscreenJobs--;
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS', 'USER_MEDIA'], justification: '영상 파일 저장 및 탭 녹화',
  });
}

// 저장이 끝나면 숨겨진 페이지를 닫아 메모리 정리 (탭 녹화 중이면 유지)
chrome.downloads.onChanged.addListener(async d => {
  if (!d.state || d.state.current === 'in_progress') return;
  const [item] = await chrome.downloads.search({ id: d.id });
  if (!item?.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) return;
  offscreenJobs = Math.max(0, offscreenJobs - 1);
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (!tabRec && offscreenJobs === 0 && (await chrome.offscreen.hasDocument())) chrome.offscreen.closeDocument().catch(() => {});
});

// ── 탭 전체 녹화 ─────────────────────────────────────────
// 영상 요소 녹화가 막히는 사이트에서도 탭 화면+소리를 그대로 녹화한다.
// (DRM 영상은 브라우저가 검은 화면으로 내보내므로 녹화되지 않음)
async function startTabRecording(tabId, streamId, filename) {
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (tabRec) throw new Error('이미 다른 탭을 녹화 중입니다. 먼저 정지해 주세요.');
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-tabrec-start', streamId, filename });
  if (!res?.ok) throw new Error(res?.error || '탭 녹화를 시작하지 못했습니다.');
  await chrome.storage.session.set({ tabRec: { tabId, startedAt: Date.now() } });
  updateBadge(tabId);
}

async function stopTabRecording() {
  // 실제 정리는 숨겨진 페이지가 보내는 'tabrec-ended'에서 처리
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-tabrec-stop' }).catch(() => null);
  if (!res?.recording) onTabRecEnded({}); // 숨겨진 페이지가 이미 없거나 녹화 중이 아니면 상태만 정리
}

async function onTabRecEnded({ url, filename }) {
  const { tabRec } = await chrome.storage.session.get('tabRec');
  await chrome.storage.session.remove('tabRec');
  if (tabRec) updateBadge(tabRec.tabId);
  if (url) {
    offscreenJobs++;
    chrome.downloads.download({ url, filename, saveAs: false }).catch(() => { offscreenJobs--; });
  }
}

chrome.tabs.onRemoved.addListener(async tabId => {
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (tabRec?.tabId === tabId) stopTabRecording();
});
