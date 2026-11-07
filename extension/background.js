// 탭별로 네트워크에서 지나가는 "완전한 영상 파일" 주소를 모아 둔다.
// 유튜브처럼 조각(세그먼트)으로 나눠 스트리밍하는 영상은 여기서 잡히지 않으며,
// 팝업의 "녹화 저장"으로 처리한다.

const MAX_PER_TAB = 30;
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
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then(id => sendResponse({ ok: true, id }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
