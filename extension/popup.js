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

let docIds = new Set(); // 지금 페이지를 이루는 문서들
async function frameVideos() {
  // 창을 열 때 한 번만 content.js를 모든 프레임에 주입(이미 있으면 무시)하고, 이후엔 목록만 다시 요청
  if (!frameIds || $('#refresh').dataset.force) {
    delete $('#refresh').dataset.force;
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ['content.js'],
    }).catch(() => []);
    frameIds = injected.map(r => r.frameId);
    docIds = new Set(injected.map(r => r.documentId).filter(Boolean));
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
  else if (msg.type === 'record' && msg.range) say(`${fmtTime(msg.range.from)}~${fmtTime(Math.min(msg.range.to, msg.duration ?? msg.range.to))} 구간을 녹화합니다. 끝 지점에서 자동으로 저장됩니다.`);
  else if (msg.type === 'record') say('녹화를 시작했습니다. 페이지 위의 "정지 후 저장" 또는 툴바의 Tonicstream 아이콘을 누르면 바로 저장됩니다.');
  setTimeout(render, 300);
}

function videoCard(v, i) {
  const info = `${v.width}×${v.height} · ${fmtTime(v.duration)}${i === 0 && v.active && !v.recording ? ' · 지금 보는 영상' : ''}`;
  const row = el('div', { className: 'row' });
  let form = '';
  if (v.recording) {
    row.append(el('span', { className: 'rec', textContent: `${v.hold ? `❚❚ ${v.hold}` : '● 녹화 중'} ${fmtTime(v.elapsed)}`,
      title: v.hold ? '영상이 멈춰 있는 동안은 녹화도 쉬었다가 이어 붙입니다' : '' }),
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
    const a = parseTime(from.value);
    let b = parseTime(to.value);
    if (!(a >= 0) || !(b > a) || a >= v.duration) return say('구간을 다시 확인해 주세요. 예) 시작 0:10, 끝 0:25');
    // 화면에는 초 단위로 내림해 보여주므로(59.9초 → 0:59), 끝을 영상 끝으로 둔 경우 마지막 1초가 잘리지 않게 끝까지 녹화한다
    if (b >= Math.floor(v.duration)) b = v.duration + 1;
    send(v.frameId, { type: 'record', id: v.id, fromStart: false, title, range: { from: a, to: b }, duration: v.duration });
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

function fileCard(f, i, all) {
  let host = '', name = '';
  try { const u = new URL(f.url); host = u.hostname; name = decodeURIComponent(u.pathname.split('/').pop() || ''); } catch {}
  if (name.length > 38) name = name.slice(0, 22) + '…' + name.slice(-13);
  // 크기순으로 늘어놓으므로 맨 위가 보통 가장 화질이 좋은 파일이다
  const best = all.length > 1 && i === 0 && f.size ? ' · 가장 큰 파일' : '';
  return el('div', { className: 'card' },
    el('div', { className: 'meta', textContent: `${fmtSize(f.size)}${best} · ${host}` }),
    ...(name ? [el('div', { className: 'meta fname', textContent: name + (f.found ? ' · 페이지에서 찾음' : '') })] : []),
    el('div', { className: 'row' }, el('button', { className: 'primary', textContent: '다운로드', onclick: () => download(f.url, f.type) })));
}

// 페이지 안에 적혀 있는 영상 주소를 찾아(아직 재생하지 않은 영상 등) 목록에 더한다. 팝업을 열 때와 새로고침 때 한 번씩.
async function scanForFiles() {
  const replies = await Promise.all((frameIds || [0]).map(frameId =>
    chrome.tabs.sendMessage(tab.id, { type: 'scan' }, { frameId }).catch(() => null)));
  const urls = [...new Set(replies.flatMap(r => r?.urls || []))];
  if (!urls.length) return;
  const res = await chrome.runtime.sendMessage({ type: 'probe-media', tabId: tab.id, urls }).catch(() => null);
  if (res?.added) render();
}

async function download(url, type = '', v = null) {
  // 보관함 미리보기용 그림 (꺼낼 수 없는 영상이면 빈 값)
  const thumb = v ? (await chrome.tabs.sendMessage(tab.id, { type: 'thumb', id: v.id }, { frameId: v.frameId }).catch(() => null))?.thumb || '' : '';
  // 주소의 확장자를 먼저 보고, 없으면 파일 형식(video/webm 등)으로 정한다
  let fromUrl = '';
  try { fromUrl = new URL(url).pathname.match(/\.(mp4|m4v|webm|mov|ogv|mkv)$/i)?.[1].toLowerCase() || ''; } catch {}
  const fromType = { 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/ogg': 'ogv', 'video/x-matroska': 'mkv' }[type.split(';')[0]] || '';
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
  // 시크릿 창에서 시작한 화면 녹화는 보관함에 남기지 않도록 알려 둔다
  // 녹화가 이미 진행 중일 때(녹화 창 보기)는 건드리지 않는다. 진행 중인 녹화의 값이 바뀌면 안 된다.
  if (!(await chrome.storage.session.get('screenRec')).screenRec) {
    await chrome.storage.session.set({ screenRecIncognito: !!tab?.incognito });
  }
  const [existing] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [RECORDER_URL] });
  // 브라우저의 화면 선택 창이 이 창 안에 그려지므로, 잘리지 않게 넉넉한 크기로 연다 (녹화가 시작되면 스스로 작아진다)
  if (existing) await chrome.windows.update(existing.windowId, { state: 'normal', focused: true });
  else await chrome.windows.create({ url: RECORDER_URL, type: 'popup', width: 720, height: 800, focused: true });
  window.close();
}

async function renderScreenRec() {
  const { screenRec } = await chrome.storage.session.get('screenRec');
  const box = $('#screenrec');
  if (screenRec) {
    box.replaceChildren(
      el('span', { className: 'rec', textContent: `${screenRec.pausedAt ? '❚❚ 일시정지' : '● 화면 녹화 중'} ${fmtTime(((screenRec.pausedAt || Date.now()) - screenRec.startedAt - (screenRec.pausedMs || 0)) / 1000)}` }),
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

// 릴스·쇼츠 같은 피드는 다음 영상들을 미리 불러 두기 때문에 영상이 여러 개 잡힌다.
// 지금 화면에서 재생 중인 영상(과 녹화 중인 영상)만 먼저 보여주고, 나머지는 접어 둔다.
let showOthers = false;
function videoList(videos) {
  if (!videos.length) return [el('p', { className: 'empty', textContent: '재생 중인 영상이 없습니다. 영상을 재생하거나 아래 "탭 녹화"를 이용하세요.' })];
  // 멈춰 둔 영상도 화면에 크게 보이고 있으면 계속 보여준다 (원하는 장면에서 멈추고 캡처·구간 지정하는 경우)
  const biggest = Math.max(0, ...videos.filter(v => v.visible).map(v => v.area));
  const isMain = v => v.recording || v.active || (v.visible && v.area >= biggest * 0.5);
  const main = videos.filter(isMain);
  if (!main.length || main.length === videos.length) return videos.map(videoCard);
  const others = videos.filter(v => !isMain(v));
  const box = el('details', { className: 'others', open: showOthers },
    el('summary', { textContent: `다른 영상 ${others.length}개 ` }, el('small', { textContent: '화면 밖에 있거나 작게 보이는 영상' })),
    ...others.map((v, i) => videoCard(v, i + main.length)));
  // 펼친 상태를 기억해 두어야 1초마다 다시 그릴 때 도로 접히지 않는다
  box.querySelector('summary').addEventListener('click', () => { showOthers = !box.open; });
  return [...main.map(videoCard), box];
}

async function render() {
  renderScreenRec();
  const [videos, files, rec, hasStream] = await Promise.all([
    frameVideos(),
    chrome.runtime.sendMessage({ type: 'getMedia', tabId: tab.id }),
    chrome.runtime.sendMessage({ type: 'tabrec-status' }),
    chrome.runtime.sendMessage({ type: 'has-stream', tabId: tab.id }).catch(() => false),
  ]);
  renderTabRec(rec);
  $('#videos').replaceChildren(...videoList(videos));
  // 뒤로 가기 등으로 다른 페이지의 파일이 남아 있으면 지금 페이지 것만 보여준다
  const mine = (files || []).filter(f => !f.documentId || !docIds.size || docIds.has(f.documentId))
    .sort((a, b) => (b.size || 0) - (a.size || 0)); // 큰 파일(보통 고화질)부터
  const none = hasStream
    ? '이 페이지는 영상을 조각으로 나눠 보내는 스트리밍 방식이라 원본 파일이 따로 없습니다. 위의 "화면 녹화 저장"을 이용하세요.'
    : '감지된 원본 파일이 없습니다. 영상을 한 번 재생하면 잡히는 경우가 많습니다.';
  $('#files').replaceChildren(...(mine.length ? mine.map(fileCard) : [el('p', { className: 'empty', textContent: none })]));
}

// ── 저장 설정 (폴더·파일 이름 규칙) ──
async function initNaming() {
  const naming = await getNaming();
  const folder = $('#nm-folder'), pattern = $('#nm-pattern'), lib = $('#nm-library');
  const quality = $('#nm-quality'), board = $('#nm-board'), hover = $('#nm-hover');
  folder.value = naming.folder; pattern.value = naming.pattern; lib.checked = naming.library;
  quality.value = naming.quality; board.value = naming.board; hover.value = naming.hover;
  // 이미 쓰고 있는 보드 이름을 고를 수 있게 제안. 보관함 전체를 읽어야 해서, 팝업을 열 때가 아니라 칸을 누를 때 한 번만 읽는다.
  board.addEventListener('focus', async () => {
    const { library = [] } = await chrome.storage.local.get('library');
    $('#nm-boards').replaceChildren(...[...new Set(library.map(x => x.board).filter(Boolean))].map(b => el('option', { value: b })));
  }, { once: true });
  lib.onchange = quality.onchange = hover.onchange = () => update(true);
  board.oninput = () => update(true);
  const update = async save => {
    const n = { folder: safeFolder(folder.value), pattern: pattern.value, library: lib.checked,
      quality: quality.value, board: board.value.trim().slice(0, 40), hover: hover.value };
    if (save) await chrome.storage.local.set({ naming: n });
    if (save === 'tidy') folder.value = n.folder; // 입력을 마쳤을 때만 칸의 글자를 정리
    $('#nm-preview').textContent = `예) 다운로드/${formatName(n, tab?.title || '영상 제목', tab?.url || 'https://www.youtube.com/', 'mp4')}`;
  };
  // 팝업은 바깥을 누르면 바로 닫히므로 글자를 칠 때마다 저장한다
  folder.oninput = () => update(true);
  folder.onchange = () => update('tidy');
  pattern.onchange = () => update(true);
  update(false);
}

// 버튼을 누르는 도중 목록을 다시 그리면 그 버튼이 사라져 클릭이 먹지 않으므로, 누르고 있는 동안은 건너뛴다
let pressing = false;
addEventListener('pointerdown', () => { pressing = true; }, true);
addEventListener('pointerup', () => setTimeout(() => { pressing = false; }, 50), true);
addEventListener('pointercancel', () => { pressing = false; }, true);

// ── 새 버전 알림 ──
// ZIP으로 설치한 확장은 브라우저가 자동으로 업데이트하지 않는다. 그래서 팝업을 열 때(12시간에 한 번)
// 사이트의 version.json을 읽어 더 새 버전이 있으면 알려준다. 보내는 정보는 없고, 받은 것은 버전 번호와 안내 문구뿐이다.
// 스토어에서 설치한 경우(manifest에 update_url이 있음)는 브라우저가 알아서 업데이트하므로 확인하지 않는다.
const UPDATE_INFO = 'https://stream.plustonic.com/version.json';
const UPDATE_PAGE = 'https://stream.plustonic.com/#update';
const VERSION_RE = /^\d{1,5}(\.\d{1,5}){1,3}$/;
function isNewer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}
async function checkUpdate() {
  const manifest = chrome.runtime.getManifest();
  if (manifest.update_url) return;
  let { updateCheck } = await chrome.storage.local.get('updateCheck');
  if (!updateCheck || Date.now() - updateCheck.at > 12 * 3600_000) {
    // 확인에 실패해도(인터넷 끊김, 사이트 응답 없음, 잘못된 내용) 확인 시각은 남겨서 12시간 안에 다시 묻지 않는다.
    // 이미 알고 있던 새 버전 알림은 그대로 보여준다.
    updateCheck = { ...updateCheck, at: Date.now() };
    try {
      const info = await (await fetch(UPDATE_INFO, { cache: 'no-store', credentials: 'omit' })).json();
      if (VERSION_RE.test(String(info.version))) {
        updateCheck.latest = String(info.version);
        updateCheck.notes = (Array.isArray(info.notes) ? info.notes : []).slice(0, 3).map(n => String(n).slice(0, 80));
      }
    } catch {}
    await chrome.storage.local.set({ updateCheck });
  }
  if (!VERSION_RE.test(updateCheck.latest || '') || !isNewer(updateCheck.latest, manifest.version)) return;
  if (updateCheck.dismissed === updateCheck.latest) return; // "나중에"를 누른 버전은 다시 묻지 않는다 (더 새 버전이 나오면 다시 알림)
  $('#update-title').textContent = `새 버전 ${updateCheck.latest} 출시 (지금 ${manifest.version})`;
  $('#update-notes').replaceChildren(...(updateCheck.notes || []).map(n => el('li', { textContent: n })));
  $('#update-get').onclick = () => { chrome.tabs.create({ url: UPDATE_PAGE }); window.close(); };
  $('#update-later').onclick = async () => {
    await chrome.storage.local.set({ updateCheck: { ...updateCheck, dismissed: updateCheck.latest } });
    $('#update').hidden = true;
  };
  $('#update').hidden = false;
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  initNaming();
  checkUpdate();
  $('#library').onclick = () => { chrome.tabs.create({ url: 'library.html' }); window.close(); };
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || '')) {
    // 새 탭·설정 화면 등에서는 화면 녹화만 쓸 수 있다
    await renderScreenRec();
    const note = '이 페이지에는 저장할 영상이 없습니다. 화면 녹화는 사용할 수 있습니다.';
    $('#videos').replaceChildren(el('p', { className: 'empty', textContent: note }));
    $('#files').replaceChildren(el('p', { className: 'empty', textContent: '감지된 원본 파일이 없습니다.' }));
    $('#tabrec').replaceChildren(el('span', { className: 'meta', textContent: '웹페이지에서만 쓸 수 있습니다.' }));
    $('#refresh').onclick = renderScreenRec;
    setInterval(() => { if (!pressing && document.querySelector('.rec')) renderScreenRec(); }, 1000);
    return;
  }
  $('#refresh').onclick = async () => { $('#refresh').dataset.force = '1'; await render(); scanForFiles(); };
  await render();
  scanForFiles();
  // 구간 입력칸이 열려 있으면 입력 중인 값이 지워지지 않게 새로 그리지 않는다
  setInterval(() => { if (!pressing && document.querySelector('.rec') && !document.querySelector('.range:not([hidden])')) render(); }, 1000);
})();
