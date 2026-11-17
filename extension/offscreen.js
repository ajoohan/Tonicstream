// 숨겨진 확장 페이지: 영상을 직접 받아(fetch) 저장용 임시 주소(blob URL)를 만든다.
// 틱톡처럼 Referer를 확인하는 서버를 위해 사용 (Referer는 background.js의 규칙이 붙여줌).
// 이 페이지는 확장의 배경(background)이 보낸 요청만 처리한다. 웹페이지에 들어간 content.js가 보낸 것(sender.tab 있음)은 무시.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (_sender.tab || msg.type !== 'offscreen-fetch') return;
  fetch(msg.url, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`서버 응답 ${r.status}`); return r.blob(); })
    .then(b => sendResponse({ ok: true, url: URL.createObjectURL(b) }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

// ── 탭 전체 녹화 ──
let tabRec = null; // { recorder }

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

async function startTabRec(streamId, filename) {
  const src = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: src },
    video: { mandatory: { ...src, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
  });
  // 탭 녹화 중에는 탭 소리가 꺼지므로, 사용자가 계속 들을 수 있게 다시 재생
  const audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);

  const mimeType = MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    audioCtx.close();
    tabRec = null;
    if (!chunks.length) return chrome.runtime.sendMessage({ type: 'tabrec-ended' });
    const type = recorder.mimeType || mimeType || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(new Blob(chunks, { type }));
    chrome.runtime.sendMessage({ type: 'tabrec-ended', url, filename: `${filename}.${ext}` });
  };
  recorder.onerror = () => recorder.state !== 'inactive' && recorder.stop();
  // 사용자가 탭 공유를 끊거나 탭이 사라지면 자동 저장
  stream.getVideoTracks()[0].addEventListener('ended', () => recorder.state !== 'inactive' && recorder.stop());
  recorder.start(1000);
  tabRec = { recorder };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (_sender.tab) return;
  if (msg.type === 'offscreen-tabrec-start') {
    if (tabRec) { sendResponse({ ok: false, error: '이미 녹화 중입니다.' }); return; }
    startTabRec(msg.streamId, msg.filename)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'offscreen-tabrec-stop') {
    // tabRec은 저장 준비가 끝나는 onstop에서 비워진다. 그 전까지는(정지 처리 중 포함) 녹화 중으로 답해야
    // 배경이 상태를 먼저 지워 이 페이지를 닫아 버리지 않는다.
    const recording = !!tabRec;
    if (recording && tabRec.recorder.state !== 'inactive') tabRec.recorder.stop();
    sendResponse({ ok: true, recording });
  }
});
