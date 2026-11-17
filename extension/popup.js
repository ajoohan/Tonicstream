const $ = s => document.querySelector(s);
let tab;

const fmtTime = s => s == null ? '라이브' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = b => !b ? '크기 알 수 없음' : b > 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.round(b / 1e3)}KB`;
const say = t => { $('#msg').textContent = t || ''; };

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let frameIds = null;

async function frameVideos() {
  // 창을 열 때 한 번만 content.js를 모든 프레임에 주입(이미 있으면 무시)하고, 이후엔 목록만 다시 요청
  if (!frameIds || $('#refresh').dataset.force) {
    delete $('#refresh').dataset.force;
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ['content.js'],
    }).catch(() => []);
    frameIds = injected.map(r => r.frameId);
    // 주입이 막힌 경우에도 매니페스트로 이미 들어가 있는 맨 위 프레임에는 물어본다
    if (!frameIds.length) frameIds = [0];
  }
  const replies = await Promise.all(frameIds.map(frameId =>
    chrome.tabs.sendMessage(tab.id, { type: 'list' }, { frameId }).then(res => ({ res, frameId }), () => null)));
  const out = [];
  for (const r of replies) for (const v of r?.res?.videos || []) out.push({ ...v, frameId: r.frameId });
  return out.sort((a, b) => b.recording - a.recording || b.active - a.active || b.area - a.area);
}

async function send(frameId, msg) {
  const res = await chrome.tabs.sendMessage(tab.id, msg, { frameId }).catch(e => ({ ok: false, error: e.message }));
  if (res && !res.ok) say(`${res.error} → 아래 "탭 녹화"를 이용해 보세요.`);
  else if (msg.type === 'record' && msg.range) say(`${fmtTime(msg.range.from)}~${fmtTime(msg.range.to)} 구간을 녹화합니다. 끝 지점에서 자동으로 저장됩니다.`);
  else if (msg.type === 'record') say('녹화를 시작했습니다. 페이지 위의 "정지 후 저장" 또는 툴바의 Tonicstream 아이콘을 누르면 바로 저장됩니다.');
  setTimeout(render, 300);
}

function videoCard(v, i) {
  const info = `${v.width}×${v.height} · ${fmtTime(v.duration)}${i === 0 && v.active && !v.recording ? ' · 지금 보는 영상' : ''}`;
  const row = el('div', { className: 'row' });
  let form = '';
  if (v.recording) {
    row.append(el('span', { className: 'rec', textContent: `● 녹화 중 ${fmtTime(v.elapsed)}` }),
      el('button', { className: 'primary', textContent: '정지 후 저장', onclick: () => send(v.frameId, { type: 'stop', id: v.id }) }));
  } else if (v.crossOrigin && v.directSrc) {
    row.append(el('button', { className: 'primary', textContent: '원본 MP4 다운로드', onclick: () => download(v.directSrc, '', v) }));
  } else {
    const title = tab.title;
    if (v.duration != null) {
      row.append(el('button', { className: 'primary', textContent: '처음부터 끝까지 녹화',
        onclick: () => send(v.frameId, { type: 'record', id: v.id, fromStart: true, title }) }));
    }
    row.append(el('button', { textContent: '지금부터 녹화',
      onclick: () => send(v.frameId, { type: 'record', id: v.id, fromStart: false, title }) }));
    if (v.directSrc) {
      row.append(el('button', { textContent: '바로 다운로드', onclick: () => download(v.directSrc, '', v) }));
    }
    if (v.duration != null) {
      form = rangeForm(v, title);
      row.append(el('button', { textContent: '구간 녹화', title: '시작·끝 시간을 정해 그 부분만 녹화',
        onclick: () => { form.hidden = !form.hidden; } }));
    }
  }
  row.append(el('button', { textContent: '장면 캡처', title: '지금 보이는 장면을 PNG 이미지로 저장', onclick: () => snapshot(v) }));
  return el('div', { className: 'card' }, el('div', { className: 'meta', textContent: info }), row, form);
}

// "1:23", "83", "1:02:03" → 초. 잘못된 값이면 NaN
function parseTime(s) {
  const p = String(s).trim().split(':').map(x => x.trim());
  if (!p.length || p.length > 3 || p.some(x => !/^\d+(\.\d+)?$/.test(x))) return NaN;
  return p.reduce((acc, x) => acc * 60 + Number(x), 0);
}

// 구간 녹화 입력칸: 시작은 지금 재생 위치, 끝은 영상 끝으로 채워 둔다
function rangeForm(v, title) {
  const from = el('input', { type: 'text', value: fmtTime(v.time), inputMode: 'numeric' });
  const to = el('input', { type: 'text', value: fmtTime(v.duration), inputMode: 'numeric' });
  const go = el('button', { className: 'primary', textContent: '이 구간 녹화', onclick: () => {
    const a = parseTime(from.value), b = Math.min(parseTime(to.value), v.duration);
    if (!(a >= 0) || !(b > a)) return say('구간을 다시 확인해 주세요. 예) 시작 0:10, 끝 0:25');
    send(v.frameId, { type: 'record', id: v.id, fromStart: false, title, range: { from: a, to: b } });
  } });
  return el('div', { className: 'range', hidden: true },
    el('label', {}, '시작', from), el('label', {}, '끝', to), go,
    el('div', { className: 'meta', textContent: `분:초로 적어주세요. 영상 길이 ${fmtTime(v.duration)}` }));
}

// 지금 보이는 장면을 PNG로 저장. 페이지 안에서 못 꺼내는 영상은 탭 화면을 찍어 영상 부분만 잘라낸다.
async function snapshot(v) {
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'snapshot', id: v.id, title: tab.title }, { frameId: v.frameId })
    .catch(e => ({ ok: false, error: e.message }));
  if (res?.ok) return say(`장면을 저장했습니다. (${res.width}×${res.height})`);
  if (!res?.fallback) return say(`장면 캡처 실패: ${res?.error || ''}`);
  const shot = await chrome.runtime.sendMessage({ type: 'shot-tab', tabId: tab.id, windowId: tab.windowId, vw: res.vw,
    rect: res.top ? res.rect : null, title: tab.title, pageUrl: tab.url, suffix: res.suffix });
  say(shot?.ok ? (res.top ? '장면을 저장했습니다. (화면에 보이는 크기)' : '장면을 저장했습니다. (탭 화면 전체)') : `장면 캡처 실패: ${shot?.error || ''}`);
}

function fileCard(f) {
  let host = '';
  try { host = new URL(f.url).hostname; } catch {}
  return el('div', { className: 'card' },
    el('div', { className: 'meta', textContent: `${fmtSize(f.size)} · ${host}` }),
    el('div', { className: 'row' }, el('button', { className: 'primary', textContent: '다운로드', onclick: () => download(f.url, f.type) })));
}

async function download(url, type = '', v = null) {
  // 보관함 미리보기용 그림 (꺼낼 수 없는 영상이면 빈 값)
  const thumb = v ? (await chrome.tabs.sendMessage(tab.id, { type: 'thumb', id: v.id }, { frameId: v.frameId }).catch(() => null))?.thumb || '' : '';
  // 주소의 확장자를 먼저 보고, 없으면 파일 형식(video/webm 등)으로 정한다
  let fromUrl = '';
  try { fromUrl = new URL(url).pathname.match(/\.(mp4|webm|mov)$/i)?.[1].toLowerCase() || ''; } catch {}
  const fromType = { 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mp4': 'mp4' }[type.split(';')[0]] || '';
  const ext = fromUrl || fromType || 'mp4';
  const res = await chrome.runtime.sendMessage({ type: 'download', url, title: tab.title, pageUrl: tab.url, ext, thumb, incognito: tab.incognito });
  say(res?.ok ? '다운로드를 시작했습니다.' : `다운로드 실패: ${res?.error || ''} → "탭 녹화"를 이용해 보세요.`);
}

async function startTabRec() {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({ type: 'tabrec-start', tabId: tab.id, streamId, title: tab.title, pageUrl: tab.url });
    say(res?.ok ? '' : res?.error);
  } catch (e) {
    say(`탭 녹화를 시작하지 못했습니다: ${e.message}`);
  }
  render();
}

function renderTabRec(rec) {
  const box = $('#tabrec');
  if (rec && rec.tabId === tab.id) {
    box.replaceChildren(
      el('span', { className: 'rec', textContent: `● 탭 녹화 중 ${fmtTime((Date.now() - rec.startedAt) / 1000)}` }),
      el('button', { className: 'primary', textContent: '정지 후 저장',
        onclick: async () => { await chrome.runtime.sendMessage({ type: 'tabrec-stop' }); say('저장 중입니다…'); setTimeout(render, 800); } }));
  } else if (rec) {
    box.replaceChildren(el('span', { className: 'meta', textContent: '다른 탭을 녹화 중입니다.' }),
      el('button', { textContent: '그 녹화 정지 후 저장', onclick: async () => { await chrome.runtime.sendMessage({ type: 'tabrec-stop' }); setTimeout(render, 800); } }));
  } else {
    box.replaceChildren(el('button', { className: 'primary', textContent: '탭 녹화 시작', onclick: startTabRec }));
  }
}

// ── 화면 녹화: 별도 창(recorder.html)에서 진행 ──
const RECORDER_URL = chrome.runtime.getURL('recorder.html');

async function openRecorder() {
  const [existing] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [RECORDER_URL] });
  if (existing) await chrome.windows.update(existing.windowId, { state: 'normal', focused: true });
  else await chrome.windows.create({ url: RECORDER_URL, type: 'popup', width: 400, height: 380, focused: true });
  window.close();
}

async function renderScreenRec() {
  const { screenRec } = await chrome.storage.session.get('screenRec');
  const box = $('#screenrec');
  if (screenRec) {
    box.replaceChildren(
      el('span', { className: 'rec', textContent: `● 화면 녹화 중 ${fmtTime((Date.now() - screenRec.startedAt) / 1000)}` }),
      el('button', { className: 'primary', textContent: '정지 후 저장', onclick: async () => {
        const res = await chrome.runtime.sendMessage({ type: 'screenrec-stop' }).catch(() => null);
        if (!res?.recording) await chrome.storage.session.remove('screenRec'); // 녹화 창이 이미 사라진 경우 표시만 정리
        say('저장 중입니다…'); setTimeout(renderScreenRec, 800);
      } }),
      el('button', { textContent: '녹화 창 보기', onclick: openRecorder }));
  } else {
    box.replaceChildren(el('button', { className: 'primary', textContent: '화면 녹화 시작', onclick: openRecorder }));
  }
}

async function render() {
  renderScreenRec();
  const [videos, files, rec] = await Promise.all([
    frameVideos(),
    chrome.runtime.sendMessage({ type: 'getMedia', tabId: tab.id }),
    chrome.runtime.sendMessage({ type: 'tabrec-status' }),
  ]);
  renderTabRec(rec);
  $('#videos').replaceChildren(...(videos.length ? videos.map(videoCard)
    : [el('p', { className: 'empty', textContent: '재생 중인 영상이 없습니다. 영상을 재생하거나 아래 "탭 녹화"를 이용하세요.' })]));
  $('#files').replaceChildren(...(files?.length ? files.map(fileCard)
    : [el('p', { className: 'empty', textContent: '감지된 원본 파일이 없습니다.' })]));
}

// ── 저장 설정 (폴더·파일 이름 규칙) ──
async function initNaming() {
  const naming = await getNaming();
  const folder = $('#nm-folder'), pattern = $('#nm-pattern'), lib = $('#nm-library');
  folder.value = naming.folder; pattern.value = naming.pattern; lib.checked = naming.library;
  lib.onchange = () => update(true);
  const update = async save => {
    const n = { folder: safeFolder(folder.value), pattern: pattern.value, library: lib.checked };
    if (save) { await chrome.storage.local.set({ naming: n }); folder.value = n.folder; }
    $('#nm-preview').textContent = `예) 다운로드/${formatName(n, tab?.title || '영상 제목', tab?.url || 'https://www.youtube.com/', 'mp4')}`;
  };
  folder.oninput = () => update(false);
  folder.onchange = () => update(true);
  pattern.onchange = () => update(true);
  update(false);
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  initNaming();
  $('#library').onclick = () => { chrome.tabs.create({ url: 'library.html' }); window.close(); };
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || '')) {
    // 새 탭·설정 화면 등에서는 화면 녹화만 쓸 수 있다
    await renderScreenRec();
    const note = '이 페이지에는 저장할 영상이 없습니다. 화면 녹화는 사용할 수 있습니다.';
    $('#videos').replaceChildren(el('p', { className: 'empty', textContent: note }));
    $('#files').replaceChildren(el('p', { className: 'empty', textContent: '감지된 원본 파일이 없습니다.' }));
    $('#tabrec').replaceChildren(el('span', { className: 'meta', textContent: '웹페이지에서만 쓸 수 있습니다.' }));
    $('#refresh').onclick = renderScreenRec;
    setInterval(() => { if (document.querySelector('.rec')) renderScreenRec(); }, 1000);
    return;
  }
  $('#refresh').onclick = () => { $('#refresh').dataset.force = '1'; render(); };
  await render();
  // 구간 입력칸이 열려 있으면 입력 중인 값이 지워지지 않게 새로 그리지 않는다
  setInterval(() => { if (document.querySelector('.rec') && !document.querySelector('.range:not([hidden])')) render(); }, 1000);
})();
