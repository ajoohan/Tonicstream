// 탭 녹화 조절 창: 녹화 시간과 "정지 후 저장" 버튼을 항상 보이게 띄워 둔다.
// 녹화는 숨겨진 페이지(offscreen)에서 진행되므로 이 창을 닫아도 녹화는 계속된다.
const $ = s => document.querySelector(s);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let startedAt = null;

async function init() {
  const { tabRec } = await chrome.storage.session.get('tabRec');
  if (!tabRec) return ended();
  startedAt = tabRec.startedAt;
  const tab = await chrome.tabs.get(tabRec.tabId).catch(() => null);
  $('#what').textContent = tab?.title || '';
  tick();
}

function tick() {
  if (startedAt) $('#timer').textContent = `● ${fmt((Date.now() - startedAt) / 1000)}`;
}

function ended() {
  startedAt = null;
  document.title = 'Tonicstream';
  $('#timer').textContent = '저장했습니다';
  $('#timer').style.color = 'var(--fg)';
  $('#stop').hidden = true;
  $('#hint').textContent = '다운로드 폴더를 확인하세요. 이 창은 곧 닫힙니다.';
  setTimeout(() => window.close(), 2500);
}

$('#stop').onclick = async () => {
  $('#stop').disabled = true;
  $('#stop').textContent = '저장 중…';
  await chrome.runtime.sendMessage({ type: 'tabrec-stop' }).catch(() => {});
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.tabRec && !changes.tabRec.newValue) ended();
});
setInterval(tick, 500);
init();
