// 화면 녹화 창: 모니터 전체·프로그램 창·탭을 골라 녹화하고 MP4로 저장한다.
// 브라우저는 화면 선택(getDisplayMedia)을 사용자가 이 창에서 직접 클릭했을 때만 허용하므로
// 팝업이 아닌 별도 창에서 진행한다. 녹화가 이 창 안에서 이뤄지므로 창을 닫으면 녹화가 취소된다.

const $ = s => document.querySelector(s);
const say = t => { $('#msg').textContent = t || ''; };
const show = id => ['idle', 'recording', 'done'].forEach(s => { $(`#${s}`).hidden = s !== id; });
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pad = n => String(n).padStart(2, '0');

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

let rec = null; // { recorder, streams, audioCtx, startedAt, timer }
let myWindowId;
// 화면 선택 창은 이 창 안에 그려진다. 고를 때는 크게, 녹화 중·저장 후에는 작게 둔다.
const BIG = { width: 720, height: 800 }, SMALL = { width: 420, height: 340 };
const resize = size => { if (myWindowId != null) chrome.windows.update(myWindowId, { state: 'normal', ...size }).catch(() => {}); };
chrome.windows.getCurrent().then(w => { myWindowId = w.id; if (w.width < BIG.width || w.height < BIG.height) resize(BIG); });

function fileName(d = new Date()) {
  return `화면 녹화 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function surfaceLabel(track) {
  const s = track.getSettings().displaySurface;
  return { monitor: '모니터 전체를 녹화하고 있습니다.', window: '프로그램 창을 녹화하고 있습니다.', browser: '브라우저 탭을 녹화하고 있습니다.' }[s] || '';
}

// 화면 소리와 마이크를 하나의 오디오 트랙으로 합친다.
function mixAudio(tracks) {
  if (tracks.length <= 1) return { tracks, audioCtx: null };
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  for (const t of tracks) audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
  return { tracks: dest.stream.getAudioTracks(), audioCtx };
}

async function start() {
  say('');
  let display, mic;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: true,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude', // 이 녹화 창 자체는 목록에서 제외
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') say(`화면을 선택하지 못했습니다: ${e.message}`);
    return;
  }
  if ($('#mic').checked) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      say('마이크를 쓸 수 없어 마이크 없이 녹화합니다. (주소창 왼쪽의 권한 설정을 확인해 주세요)');
    }
  }

  const [video] = display.getVideoTracks();
  const { tracks: audio, audioCtx } = mixAudio([...display.getAudioTracks(), ...(mic?.getAudioTracks() || [])]);
  const stream = new MediaStream([video, ...audio]);
  const mimeType = MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  const name = fileName();
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  const thumbP = grabThumb(display);
  recorder.onstop = () => finish(chunks, recorder.mimeType || mimeType || 'video/webm', name, thumbP);
  recorder.onerror = () => recorder.state !== 'inactive' && recorder.stop();
  // 브라우저의 "공유 중지"를 누르거나 녹화하던 창이 닫히면 자동 저장
  video.addEventListener('ended', stop);
  recorder.start(1000);

  const startedAt = Date.now();
  rec = {
    recorder, audioCtx, startedAt, streams: [display, mic].filter(Boolean),
    timer: setInterval(() => { $('#timer').textContent = `● ${fmtTime((Date.now() - startedAt) / 1000)}`; }, 500),
  };
  $('#timer').textContent = '● 0:00';
  $('#what').textContent = surfaceLabel(video);
  show('recording');
  document.title = '● 녹화 중 - Tonicstream';
  await chrome.storage.session.set({ screenRec: { startedAt, windowId: myWindowId } });
  chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
  chrome.action.setBadgeText({ text: 'REC' });
  // 녹화 화면에 이 창이 가리지 않도록 내려 둔다
  if (video.getSettings().displaySurface === 'monitor' && myWindowId != null) {
    chrome.windows.update(myWindowId, { state: 'minimized' }).catch(() => {});
  } else {
    resize(SMALL);
  }
}

function stop() {
  if (rec?.recorder.state === 'recording') rec.recorder.stop();
}

function cleanup() {
  if (!rec) return;
  clearInterval(rec.timer);
  rec.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  rec.audioCtx?.close();
  rec = null;
  document.title = 'Tonicstream 화면 녹화';
  chrome.storage.session.remove('screenRec');
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
}

// 보관함 미리보기용: 녹화 화면의 한 장면을 작은 그림으로
async function grabThumb(stream) {
  try {
    const v = Object.assign(document.createElement('video'), { muted: true, srcObject: new MediaStream(stream.getVideoTracks()) });
    await v.play();
    await new Promise(r => setTimeout(r, 400));
    const k = Math.min(1, 240 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    v.srcObject = null;
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return ''; }
}

async function finish(chunks, type, name, thumbP) {
  cleanup();
  if (myWindowId != null) chrome.windows.update(myWindowId, { state: 'normal', focused: true, ...SMALL }).catch(() => {});
  if (!chunks.length) { show('idle'); say('녹화된 내용이 없습니다.'); return; }
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(new Blob(chunks, { type }));
  try {
    // 저장이 끝날 때까지 이 창이 열려 있어야 임시 주소(blob)가 유지된다
    // 이름에 이미 날짜가 있으므로 저장 폴더 설정만 적용
    const filename = await buildName(name, '', ext, { plain: true });
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    const { screenRecIncognito } = await chrome.storage.session.get('screenRecIncognito');
    chrome.runtime.sendMessage({ type: 'log-save', entry: { kind: '화면 녹화', title: name, pageUrl: '', filename, downloadId, thumb: await thumbP, incognito: !!screenRecIncognito } }).catch(() => {});
    // 긴 녹화는 파일을 쓰는 데 시간이 걸린다. 다 쓸 때까지 창을 닫지 못하게 한다 (닫으면 임시 파일이 사라져 저장이 끊긴다)
    saving = true;
    $('#saved').textContent = '저장 중입니다… 창을 닫지 마세요.';
    $('#again').disabled = $('#close').disabled = true;
    show('done');
    const state = await waitDownload(downloadId);
    $('#saved').textContent = state === 'complete' ? `저장했습니다: ${name}.${ext}` : '저장하지 못했습니다. 다시 녹화해 주세요.';
  } catch (e) {
    $('#saved').textContent = `저장하지 못했습니다: ${e.message}`;
  }
  saving = false;
  $('#again').disabled = $('#close').disabled = false;
  show('done');
}

let saving = false;
async function waitDownload(id) {
  for (;;) {
    const [d] = await chrome.downloads.search({ id });
    if (!d || d.state !== 'in_progress') return d?.state || 'interrupted';
    await new Promise(r => setTimeout(r, 300));
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (_sender.tab) return; // 팝업·배경이 보낸 것만 (웹페이지 속 스크립트는 거절)
  if (msg.type === 'screenrec-stop') { const was = !!rec; stop(); sendResponse({ ok: true, recording: was }); }
});

// 녹화 도중 창을 닫으면 상태 표시만 정리 (녹화 내용은 저장되지 않음)
addEventListener('pagehide', () => { if (rec) cleanup(); });
addEventListener('beforeunload', e => { if (rec || saving) e.preventDefault(); });

$('#start').onclick = start;
$('#stop').onclick = stop;
$('#again').onclick = () => { resize(BIG); show('idle'); say(''); };
$('#close').onclick = () => window.close();
