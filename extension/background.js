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
      requestHeaders: [
        { header: 'referer', operation: 'set', value: 'https://www.tiktok.com/' },
        { header: 'origin', operation: 'set', value: 'https://www.tiktok.com' },
      ],
    },
    condition: { requestDomains: TIKTOK_CDN, tabIds: [-1], resourceTypes: ['xmlhttprequest', 'other'] },
  }],
});
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
    chrome.action.setBadgeText({ tabId: details.tabId, text: String(list.length) });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

async function clearTab(tabId) {
  const media = await load();
  if (!media[tabId]) return;
  delete media[tabId];
  save(media);
}

chrome.tabs.onRemoved.addListener(clearTab);
chrome.webRequest.onBeforeRequest.addListener(
  d => { if (d.tabId >= 0) clearTab(d.tabId); },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

async function download(url, filename) {
  if (!isTikTokCdn(url)) return chrome.downloads.download({ url, filename, saveAs: false });
  // 틱톡: 다운로드 API 요청에는 Referer를 붙일 수 없어서, 숨겨진 페이지에서 받아 저장
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: '영상 파일 저장' });
  }
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-fetch', url });
  if (!res?.ok) throw new Error(res?.error || '받기 실패');
  return chrome.downloads.download({ url: res.url, filename, saveAs: false });
}

// 저장이 끝나면 숨겨진 페이지를 닫아 메모리 정리
chrome.downloads.onChanged.addListener(async d => {
  if (!d.state || d.state.current === 'in_progress') return;
  const [item] = await chrome.downloads.search({ id: d.id });
  if (item?.url.startsWith('blob:') && (await chrome.offscreen.hasDocument())) chrome.offscreen.closeDocument();
});
