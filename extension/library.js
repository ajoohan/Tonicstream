// 레퍼런스 보관함: 저장 기록을 보고, 메모·태그를 달고, CSV로 내보낸다.
// 기록은 이 브라우저의 chrome.storage.local('library')에만 있다.
const $ = s => document.querySelector(s);
const say = t => { $('#msg').textContent = t || ''; };
let items = [];

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const pad = n => String(n).padStart(2, '0');
const fmtDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// 저장 도중 새 기록이 추가돼도 서로 덮어쓰지 않도록, 고치는 일은 모두 배경(background)의 한 줄 대기열에서 처리한다
// change: 바꿀 값, null이면 그 기록 삭제. id가 null이면 전체 삭제
const update = (id, change) => chrome.runtime.sendMessage({ type: 'library-update', id, change });

async function showFile(it) {
  const [d] = it.downloadId != null ? await chrome.downloads.search({ id: it.downloadId }) : [];
  if (d?.exists) { say(''); return chrome.downloads.show(d.id); }
  say(`파일을 찾지 못했습니다. 옮기거나 지웠을 수 있습니다: ${it.filename}`);
}

function card(it) {
  const thumb = el('div', { className: 'thumb', textContent: it.thumb ? '' : '미리보기 없음' });
  if (it.thumb.startsWith('data:image/')) thumb.style.backgroundImage = `url("${it.thumb}")`;
  const tags = el('input', { type: 'text', value: it.tags, placeholder: '태그 (쉼표로 구분)', onchange: e => update(it.id, { tags: e.target.value.trim() }) });
  const memo = el('input', { type: 'text', value: it.memo, placeholder: '메모', onchange: e => update(it.id, { memo: e.target.value.trim() }) });
  const acts = el('div', { className: 'acts' },
    el('button', { textContent: '파일 위치 열기', onclick: () => showFile(it) }));
  if (it.pageUrl) acts.append(el('button', { textContent: '원본 페이지', onclick: () => chrome.tabs.create({ url: it.pageUrl }) }));
  acts.append(el('button', { textContent: '기록 삭제', onclick: () => update(it.id, null) }));
  return el('div', { className: 'item' }, thumb,
    el('div', { className: 'body' },
      el('div', { className: 'title', textContent: it.title || it.filename, title: it.filename }),
      el('div', { className: 'sub' }, el('span', { className: 'kind', textContent: it.kind }), `${fmtDate(it.ts)}${it.site ? ' · ' + it.site : ''}`),
      tags, memo, acts));
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const shown = q ? items.filter(it => [it.title, it.site, it.tags, it.memo, it.kind, it.filename].join(' ').toLowerCase().includes(q)) : items;
  $('#count').textContent = q ? `${items.length}개 중 ${shown.length}개` : `${items.length}개`;
  $('#list').replaceChildren(...(shown.length ? shown.map(card)
    : [el('p', { className: 'empty', textContent: items.length ? '검색 결과가 없습니다.' : '아직 기록이 없습니다. 영상을 저장하면 여기에 쌓입니다.' })]));
}

function exportCsv() {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['날짜', '종류', '제목', '사이트', '원본 주소', '파일', '태그', '메모'],
    ...items.map(it => [fmtDate(it.ts), it.kind, it.title, it.site, it.pageUrl, it.filename, it.tags, it.memo])];
  // 엑셀에서 한글이 깨지지 않도록 맨 앞에 BOM을 붙인다
  const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `tonicstream-보관함-${fmtDate(Date.now()).slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function load() {
  items = (await chrome.storage.local.get('library')).library || [];
  // 입력 중인 칸이 있으면 다시 그리지 않는다 (입력이 지워지지 않게)
  if (!document.activeElement?.matches('#list input')) render();
}

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.library) load(); });
$('#q').oninput = render;
$('#csv').onclick = exportCsv;
$('#clear').onclick = async () => {
  if (items.length && confirm(`기록 ${items.length}개를 모두 지울까요? 영상 파일은 지워지지 않습니다.`)) await update(null, null);
};
load();
