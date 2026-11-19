// 레퍼런스 보관함: 저장 기록을 보드로 묶고, 별점·메모·태그를 달고, CSV나 HTML로 내보낸다.
// 기록은 이 브라우저의 chrome.storage.local('library')에만 있다.
const $ = s => document.querySelector(s);
const say = t => { $('#msg').textContent = t || ''; };
let items = [];
const view = { board: null, kind: '', minRating: 0, sort: 'new' }; // board: null 전체, '' 미분류, 그 밖은 보드 이름

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const pad = n => String(n).padStart(2, '0');
const fmtDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const boardOf = it => it.board || '';
const ratingOf = it => it.rating || 0;
const boards = () => [...new Set(items.map(boardOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));

// 저장 도중 새 기록이 추가돼도 서로 덮어쓰지 않도록, 고치는 일은 모두 배경(background)의 한 줄 대기열에서 처리한다
// change: 바꿀 값, null이면 그 기록 삭제. (전체 삭제는 clearAll로 따로 보낸다)
const update = (id, change) => chrome.runtime.sendMessage({ type: 'library-update', id, change });
// 메모·태그는 화면에 이미 적혀 있으므로 저장 뒤 목록을 다시 그리지 않는다.
// (다시 그리면 막 누르려던 버튼이 사라져 클릭이 먹지 않는다)
let quietUntil = 0, pendingRender = false;
const edit = (id, change) => { quietUntil = Date.now() + 1500; return update(id, change); };

async function showFile(it) {
  const [d] = it.downloadId != null ? await chrome.downloads.search({ id: it.downloadId }) : [];
  // 다운로드 기록을 지운 뒤에는 같은 번호가 다른 파일에 쓰일 수 있으므로, 시작 시각이 이 기록과 맞는지도 본다
  const same = d && d.byExtensionId === chrome.runtime.id && Math.abs(Date.parse(d.startTime) - it.ts) < 10 * 60_000;
  if (same && d.exists) { say(''); return chrome.downloads.show(d.id); }
  say(`파일을 찾지 못했습니다. 옮기거나 지웠을 수 있습니다: ${it.filename}`);
}

function stars(it) {
  const box = el('div', { className: 'stars', role: 'group', ariaLabel: '별점' });
  for (let n = 1; n <= 5; n++) {
    box.append(el('button', { type: 'button', className: n <= ratingOf(it) ? 'on' : '', textContent: '★', title: `별점 ${n}점`,
      ariaLabel: `별점 ${n}점`, onclick: () => update(it.id, { rating: ratingOf(it) === n ? 0 : n }) })); // 같은 별을 다시 누르면 지움
  }
  return box;
}

function card(it) {
  const thumb = el('div', { className: 'thumb', textContent: it.thumb ? '' : '미리보기 없음' });
  if (it.thumb.startsWith('data:image/')) thumb.style.backgroundImage = `url("${it.thumb}")`;
  const board = el('input', { type: 'text', value: boardOf(it), placeholder: '보드 (예: 가을 캠페인)', onchange: e => edit(it.id, { board: e.target.value.trim() }) });
  board.setAttribute('list', 'boards');
  const tags = el('input', { type: 'text', value: it.tags, placeholder: '태그 (쉼표로 구분)', onchange: e => edit(it.id, { tags: e.target.value.trim() }) });
  const memo = el('input', { type: 'text', value: it.memo, placeholder: '메모', onchange: e => edit(it.id, { memo: e.target.value.trim() }) });
  const acts = el('div', { className: 'acts' },
    el('button', { textContent: '파일 위치 열기', onclick: () => showFile(it) }));
  if (it.pageUrl) acts.append(el('button', { textContent: '원본 페이지', onclick: () => chrome.tabs.create({ url: it.pageUrl }) }));
  acts.append(el('button', { textContent: '기록 삭제', onclick: () => update(it.id, null) }));
  return el('div', { className: 'item' }, thumb,
    el('div', { className: 'body' },
      el('div', { className: 'title', textContent: it.title || it.filename, title: it.filename }),
      el('div', { className: 'sub' }, el('span', { className: 'kind', textContent: it.kind }), `${fmtDate(it.ts)}${it.site ? ' · ' + it.site : ''}`),
      el('div', { className: 'file', textContent: it.filename, title: '저장된 파일 이름' }),
      stars(it), board, tags, memo, acts));
}

// 지금 화면에 보이는 기록(보드·종류·별점·검색어로 거른 것). 내보내기도 이 목록을 쓴다.
function shown() {
  const q = $('#q').value.trim().toLowerCase();
  const list = items.filter(it =>
    (view.board === null || boardOf(it) === view.board) &&
    (!view.kind || it.kind === view.kind) &&
    ratingOf(it) >= view.minRating &&
    (!q || [it.title, it.site, it.tags, it.memo, it.kind, it.filename, boardOf(it)].join(' ').toLowerCase().includes(q)));
  return view.sort === 'rating' ? [...list].sort((a, b) => ratingOf(b) - ratingOf(a) || b.ts - a.ts) : list;
}

function renderFilters() {
  const bs = boards();
  const none = items.filter(it => !boardOf(it)).length;
  // 고른 보드가 없어졌으면(이름 변경·삭제, 미분류가 0개가 됨) 전체 보기로 돌아간다
  if ((view.board && !bs.includes(view.board)) || (view.board === '' && !(bs.length && none))) view.board = null;
  const chip = (label, value, n) => el('button', { type: 'button', className: 'chipbtn' + (view.board === value ? ' on' : ''),
    textContent: `${label} ${n}`, onclick: () => { view.board = value; render(); } });
  $('#boardbar').replaceChildren(chip('전체', null, items.length),
    ...bs.map(b => chip(b, b, items.filter(it => boardOf(it) === b).length)),
    ...(bs.length && none ? [chip('미분류', '', none)] : []));
  $('#boards').replaceChildren(...bs.map(b => el('option', { value: b })));
  const kinds = [...new Set(items.map(it => it.kind).filter(Boolean))];
  if (view.kind && !kinds.includes(view.kind)) view.kind = '';
  $('#f-kind').replaceChildren(el('option', { value: '', textContent: '모든 저장 방법' }), ...kinds.map(k => el('option', { value: k, textContent: k })));
  $('#f-kind').value = view.kind;
}

function render() {
  renderFilters();
  const list = shown();
  $('#count').textContent = list.length === items.length ? `${items.length}개` : `${items.length}개 중 ${list.length}개`;
  $('#list').replaceChildren(...(list.length ? list.map(card)
    : [el('p', { className: 'empty', textContent: items.length ? '조건에 맞는 기록이 없습니다.' : '아직 기록이 없습니다. 영상을 저장하면 여기에 쌓입니다.' })]));
}

const stamp = () => fmtDate(Date.now()).slice(0, 10);
function saveFile(text, type, name) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function exportCsv() {
  // =, +, -, @ 로 시작하는 칸은 엑셀이 수식으로 실행할 수 있어서 앞에 '를 붙여 글자로 읽히게 한다
  const cell = v => { const s = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`; };
  const rows = [['날짜', '종류', '제목', '사이트', '원본 주소', '파일', '보드', '별점', '태그', '메모'],
    ...shown().map(it => [fmtDate(it.ts), it.kind, it.title, it.site, it.pageUrl, it.filename, boardOf(it), ratingOf(it) || '', it.tags, it.memo])];
  // 엑셀에서 한글이 깨지지 않도록 맨 앞에 BOM을 붙인다
  saveFile('﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', `tonicstream-보관함-${stamp()}.csv`);
}

// 팀에 전달하기 좋은 한 장짜리 HTML. 미리보기 그림이 파일 안에 들어 있어 이 파일 하나만 보내면 된다.
function exportHtml() {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const list = shown();
  const title = view.board === null ? '레퍼런스 보관함' : view.board === '' ? '미분류 레퍼런스' : view.board;
  const cards = list.map(it => `
  <article>
    ${/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(it.thumb) ? `<img src="${it.thumb}" alt="">` : '<div class="noimg">미리보기 없음</div>'}
    <div>
      <h2>${esc(it.title || it.filename)}</h2>
      <p class="meta"><span class="kind">${esc(it.kind)}</span> ${esc(fmtDate(it.ts))}${it.site ? ' · ' + esc(it.site) : ''}${ratingOf(it) ? ` · <span class="stars">${'★'.repeat(ratingOf(it))}</span>` : ''}</p>
      ${boardOf(it) ? `<p class="meta">보드: ${esc(boardOf(it))}</p>` : ''}
      ${it.tags ? `<p class="tags">${it.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => `<span>#${esc(t)}</span>`).join(' ')}</p>` : ''}
      ${it.memo ? `<p class="memo">${esc(it.memo)}</p>` : ''}
      ${/^https?:\/\//.test(it.pageUrl) ? `<p><a href="${esc(it.pageUrl)}" target="_blank" rel="noopener noreferrer">원본 페이지 열기</a></p>` : ''}
      <p class="file">${esc(it.filename)}</p>
    </div>
  </article>`).join('');
  saveFile(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${stamp()}</title>
<style>
  body { margin: 0; padding: 32px 20px 60px; font: 15px/1.55 "Pretendard Variable", Pretendard, system-ui, "Malgun Gothic", sans-serif; background: #f6f6f9; color: #17171c; word-break: keep-all; }
  main { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; } .lead { color: #5f5f6b; margin: 0 0 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; }
  article { display: grid; grid-template-columns: 110px 1fr; gap: 14px; background: #fff; border: 1px solid #e4e4ea; border-radius: 12px; padding: 14px; }
  img, .noimg { width: 110px; height: 110px; border-radius: 8px; object-fit: cover; background: #e4e4ea; }
  .noimg { display: grid; place-items: center; color: #5f5f6b; font-size: 12px; }
  h2 { font-size: 16px; margin: 0 0 4px; word-break: break-all; } p { margin: 4px 0; }
  .meta, .file { color: #5f5f6b; font-size: 13px; } .file { word-break: break-all; }
  .kind { color: #e5484d; border: 1px solid #e5484d; border-radius: 999px; padding: 0 7px; font-size: 12px; font-weight: 700; }
  .stars { color: #e5a000; } .tags span { color: #3b5bdb; margin-right: 4px; } .memo { background: #f6f6f9; border-radius: 8px; padding: 6px 9px; }
  a { color: #e5484d; font-weight: 600; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="lead">${list.length}개 · ${stamp()} 기준 · Tonicstream 보관함에서 내보냄</p>
<div class="grid">${cards}
</div>
</main></body></html>`, 'text/html;charset=utf-8', `tonicstream-${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || '보관함'}-${stamp()}.html`);
}

// 버튼을 누르는 도중 다시 그리면 그 버튼이 사라져 클릭이 먹지 않으므로, 누르는 동안은 미룬다
let pressing = false;
addEventListener('pointerdown', () => { pressing = true; }, true);
addEventListener('pointerup', () => setTimeout(() => { pressing = false; flush(); }, 60), true);
addEventListener('pointercancel', () => { pressing = false; }, true);

async function load() {
  items = (await chrome.storage.local.get('library')).library || [];
  // 방금 메모·태그를 고쳤거나 입력 중인 칸이 있으면 미뤘다가 그린다
  if (pressing || Date.now() < quietUntil || document.activeElement?.matches('#list input')) {
    pendingRender = true;
    if (!pressing) renderFilters(); // 보드 버튼과 개수는 입력 칸 밖이라 바로 맞춘다 (누르는 중이면 클릭이 끝난 뒤에)
    if (Date.now() < quietUntil) setTimeout(flush, quietUntil - Date.now() + 50);
    return;
  }
  render();
}
function flush() {
  if (pendingRender && !pressing && Date.now() >= quietUntil && !document.activeElement?.matches('#list input')) { pendingRender = false; render(); }
}
$('#list').addEventListener('focusout', () => setTimeout(flush, 200));

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.library) load(); });
$('#q').oninput = render;
$('#f-kind').onchange = e => { view.kind = e.target.value; render(); };
$('#f-rating').onchange = e => { view.minRating = Number(e.target.value); render(); };
$('#f-sort').onchange = e => { view.sort = e.target.value; render(); };
$('#csv').onclick = exportCsv;
$('#html').onclick = exportHtml;
$('#clear').onclick = async () => {
  if (items.length && confirm(`기록 ${items.length}개를 모두 지울까요? 영상 파일은 지워지지 않습니다.`)) await chrome.runtime.sendMessage({ type: 'library-update', clearAll: true });
};
load();
