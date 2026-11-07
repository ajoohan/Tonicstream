// 숨겨진 확장 페이지: 영상을 직접 받아(fetch) 저장용 임시 주소(blob URL)를 만든다.
// 틱톡처럼 Referer를 확인하는 서버를 위해 사용 (Referer는 background.js의 규칙이 붙여줌).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'offscreen-fetch') return;
  fetch(msg.url, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`서버 응답 ${r.status}`); return r.blob(); })
    .then(b => sendResponse({ ok: true, url: URL.createObjectURL(b) }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});
