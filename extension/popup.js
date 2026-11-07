const $ = s => document.querySelector(s);
let tab;

const fmtTime = s => s == null ? '라이브' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = b => !b ? '크기 알 수 없음' : b > 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.round(b / 1e3)}KB`;
const safeName = s => (s || 'video').replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'video';
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
  }
  const out = [];
  for (const frameId of frameIds) {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'list' }, { frameId }).catch(() => null);
    for (const v of res?.videos || []) out.push({ ...v, frameId });
  }
  return out.sort((a, b) => b.recording - a.recording || b.active - a.active || b.area - a.area);
}

async function send(frameId, msg) {
  const res = await chrome.tabs.sendMessage(tab.id, msg, { frameId }).catch(e => ({ ok: false, error: e.message }));
  if (res && !res.ok) say(`${res.error} → 아래 "탭 녹화"를 이용해 보세요.`);
  setTimeout(render, 300);
}

function videoCard(v, i) {
  const info = `${v.width}×${v.height} · ${fmtTime(v.duration)}${i === 0 && v.active && !v.recording ? ' · 지금 보는 영상' : ''}`;
  const row = el('div', { className: 'row' });
  if (v.recording) {
    row.append(el('span', { className: 'rec', textContent: `● 녹화 중 ${fmtTime(v.elapsed)}` }),
      el('button', { className: 'primary', textContent: '정지 후 저장', onclick: () => send(v.frameId, { type: 'stop', id: v.id }) }));
  } else if (v.crossOrigin && v.directSrc) {
    row.append(el('button', { className: 'primary', textContent: '원본 MP4 다운로드', onclick: () => download(v.directSrc) }));
  } else {
    const title = tab.title;
    if (v.duration != null) {
      row.append(el('button', { className: 'primary', textContent: '처음부터 끝까지 녹화',
        onclick: () => send(v.frameId, { type: 'record', id: v.id, fromStart: true, title }) }));
    }
    row.append(el('button', { textContent: '지금부터 녹화',
      onclick: () => send(v.frameId, { type: 'record', id: v.id, fromStart: false, title }) }));
    if (v.directSrc) {
      row.append(el('button', { textContent: '바로 다운로드', onclick: () => download(v.directSrc) }));
    }
  }
  return el('div', { className: 'card' }, el('div', { className: 'meta', textContent: info }), row);
}

function fileCard(f) {
  let host = '';
  try { host = new URL(f.url).hostname; } catch {}
  return el('div', { className: 'card' },
    el('div', { className: 'meta', textContent: `${fmtSize(f.size)} · ${host}` }),
    el('div', { className: 'row' }, el('button', { className: 'primary', textContent: '다운로드', onclick: () => download(f.url, f.type) })));
}

async function download(url, type = '') {
  let ext = 'mp4';
  try { ext = (type.split('/')[1] || new URL(url).pathname.split('.').pop() || '').toLowerCase(); } catch {}
  ext = { quicktime: 'mov', webm: 'webm', mov: 'mov' }[ext] || 'mp4';
  const res = await chrome.runtime.sendMessage({ type: 'download', url, filename: `${safeName(tab.title)}.${ext}` });
  say(res?.ok ? '다운로드를 시작했습니다.' : `다운로드 실패: ${res?.error || ''} → "탭 녹화"를 이용해 보세요.`);
}

async function startTabRec() {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({ type: 'tabrec-start', tabId: tab.id, streamId, filename: safeName(tab.title) });
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

async function render() {
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

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || '')) {
    say('이 페이지에서는 사용할 수 없습니다. 영상이 있는 웹페이지에서 열어주세요.');
    return;
  }
  $('#refresh').onclick = () => { $('#refresh').dataset.force = '1'; render(); };
  await render();
  setInterval(() => { if (document.querySelector('.rec')) render(); }, 1000);
})();
