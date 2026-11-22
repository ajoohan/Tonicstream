// 스트리밍(HLS) 영상 받기: 조각 목록(m3u8)을 읽어 조각을 모두 받고 하나의 MP4로 합친다.
// 숨겨진 확장 페이지(offscreen.html)에서 돌아간다. 진행 상황과 결과는 배경(background)에 메시지로 알린다.
//
// 지원: 영상과 소리가 한 조각에 함께 든 HLS (TS 조각은 MP4로 바꿔 담고, MP4 조각은 그대로 이어 붙임),
//       열쇠가 공개된 AES-128 암호화.
// 미지원: DRM(SAMPLE-AES 등), 영상과 소리가 따로 오는 방식, 생방송, 중간에 초기화 정보가 바뀌는 목록.

const HLS_MAX_BYTES = 2 * 1024 ** 3; // 한 번에 다루는 최대 크기(2GB). 넘으면 녹화를 권한다.
let hlsAbort = null;

const attrsOf = s => {
  const o = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
};

// "길이@시작" 형식의 범위. 시작이 없으면 앞 조각이 끝난 곳부터.
function byteRange(spec, prevEnd) {
  const [len, off] = spec.split('@').map(Number);
  const start = Number.isFinite(off) ? off : prevEnd;
  return { start, end: start + len - 1 };
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('스트리밍 목록 형식이 아닙니다.');
  const abs = u => new URL(u, baseUrl).href;
  const out = { variants: [], audio: [], segments: [], maps: [], ended: false, total: 0 };
  let variant = null, dur = 0, range = null, prevEnd = 0, key = null, seq = 0, map = null;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-STREAM-INF:')) variant = attrsOf(l.slice(18));
    else if (l.startsWith('#EXT-X-MEDIA:')) { const a = attrsOf(l.slice(13)); if (a.TYPE === 'AUDIO') out.audio.push({ group: a['GROUP-ID'], uri: a.URI ? abs(a.URI) : '' }); }
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrsOf(l.slice(11));
      key = !a.METHOD || a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? abs(a.URI) : '', iv: a.IV || '', format: a.KEYFORMAT || 'identity' };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrsOf(l.slice(11));
      map = { url: abs(a.URI), range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : null };
      out.maps.push(map);
    } else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) { range = byteRange(l.slice(17), prevEnd); prevEnd = range.end + 1; }
    else if (l === '#EXT-X-ENDLIST') out.ended = true;
    else if (!l.startsWith('#')) {
      if (variant) {
        out.variants.push({ url: abs(l), bandwidth: Number(variant.BANDWIDTH) || 0, resolution: variant.RESOLUTION || '', audio: variant.AUDIO || '' });
        variant = null;
      } else {
        out.segments.push({ url: abs(l), dur, range, key, seq: seq + out.segments.length, map });
        out.total += dur;
        if (!range) prevEnd = 0;
        range = null;
      }
    }
  }
  return out;
}

async function getBytes(url, range, signal) {
  const r = await fetch(url, { credentials: 'include', signal, headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {} });
  if (!r.ok) throw new Error(`서버 응답 ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function getText(url, signal) {
  const r = await fetch(url, { credentials: 'include', signal });
  if (!r.ok) throw new Error(`서버 응답 ${r.status}`);
  return r.text();
}

// 조각 목록 후보들 중에서 받을 것을 고른다: 화질 목록(마스터)이 있으면 가장 높은 화질, 없으면 가장 긴 목록.
async function pickPlaylist(urls, signal) {
  const lists = [];
  for (const url of urls.slice(0, 8)) {
    try { lists.push({ url, pl: parsePlaylist(await getText(url, signal), url) }); } catch (e) { if (signal.aborted) throw e; }
  }
  if (!lists.length) throw new Error('스트리밍 목록을 읽지 못했습니다.');
  const master = lists.find(x => x.pl.variants.length);
  if (master) {
    const best = [...master.pl.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    const separateAudio = best.audio && master.pl.audio.some(a => a.group === best.audio && a.uri);
    if (separateAudio) throw new Error('영상과 소리가 따로 오는 방식이라 아직 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
    return { url: best.url, pl: parsePlaylist(await getText(best.url, signal), best.url), quality: best.resolution };
  }
  const media = lists.filter(x => x.pl.segments.length).sort((a, b) => b.pl.total - a.pl.total)[0];
  if (!media) throw new Error('받을 영상 조각이 없습니다.');
  return { ...media, quality: '' };
}

// AES-128: 조각마다 정해진 열쇠와 초기값(IV)으로 푼다. IV가 없으면 조각 번호를 쓴다(HLS 규칙).
const keyCache = new Map();
async function decrypt(bytes, seg, signal) {
  const k = seg.key;
  if (!keyCache.has(k.uri)) {
    const raw = await getBytes(k.uri, null, signal);
    keyCache.set(k.uri, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
  }
  const iv = new Uint8Array(16);
  if (k.iv) { const hex = k.iv.replace(/^0x/i, '').padStart(32, '0'); for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16); }
  else new DataView(iv.buffer).setUint32(12, seg.seq);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyCache.get(k.uri), bytes));
}

async function hlsDownload(urls, report) {
  const ctl = new AbortController();
  hlsAbort = ctl;
  const signal = ctl.signal;
  keyCache.clear();
  const { pl, quality } = await pickPlaylist(urls, signal);
  if (!pl.ended) throw new Error('생방송처럼 끝이 정해지지 않은 스트리밍은 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
  const bad = pl.segments.find(s => s.key && (s.key.method !== 'AES-128' || s.key.format !== 'identity' || !s.key.uri));
  if (bad) throw new Error('DRM으로 보호된 영상이라 받을 수 없습니다.');
  if (new Set(pl.maps.map(m => m.url + (m.range ? m.range.start : ''))).size > 1) throw new Error('중간에 형식이 바뀌는 스트리밍이라 받을 수 없습니다. 위의 녹화를 이용해 주세요.');

  const total = pl.segments.length, parts = [];
  let bytes = 0, done = 0;
  const isFmp4 = pl.maps.length > 0;
  if (isFmp4) parts.push(await getBytes(pl.maps[0].url, pl.maps[0].range, signal));
  // TS 조각은 MP4 조각으로 바꾼다. 맨 처음 나온 초기화 정보만 앞에 두고 나머지는 차례로 이어 붙인다.
  let tm = null, gotInit = false;
  if (!isFmp4) {
    tm = new (muxjs.mp4 || muxjs).Transmuxer({ remux: true }); // mp4 전용 묶음에서는 muxjs 자체가 mp4 모듈이다
    tm.on('data', seg => { if (!gotInit) { parts.push(seg.initSegment); gotInit = true; } parts.push(seg.data); });
  }
  const BATCH = 4; // 한 번에 4개씩 받고, 순서대로 처리한다
  for (let i = 0; i < total; i += BATCH) {
    const group = pl.segments.slice(i, i + BATCH);
    const got = await Promise.all(group.map(async s => {
      const b = await getBytes(s.url, s.range, signal);
      return s.key ? decrypt(b, s, signal) : b;
    }));
    for (const b of got) {
      bytes += b.length;
      if (bytes > HLS_MAX_BYTES) throw new Error('영상이 너무 커서(2GB 초과) 한 번에 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
      if (isFmp4) parts.push(b); else { tm.push(b); tm.flush(); }
    }
    done += group.length;
    report({ done, total, bytes });
  }
  if (!isFmp4 && !gotInit) throw new Error('영상 조각을 MP4로 바꾸지 못했습니다. 위의 녹화를 이용해 주세요.');
  const blob = new Blob(parts, { type: 'video/mp4' });
  return { url: URL.createObjectURL(blob), size: blob.size, seconds: Math.round(pl.total), quality };
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.tab) return; // 배경이 보낸 것만
  if (msg.type === 'offscreen-hls-cancel') { hlsAbort?.abort(); return; }
  if (msg.type !== 'offscreen-hls') return;
  let last = 0;
  hlsDownload(msg.urls, p => {
    // 진행 상황은 0.5초에 한 번쯤만 알린다 (알릴 때마다 배경이 깨어 있게 되어 긴 작업 중 잠들지 않는다)
    if (Date.now() - last > 500 || p.done === p.total) { last = Date.now(); chrome.runtime.sendMessage({ type: 'hls-progress', ...p }).catch(() => {}); }
  }).then(
    res => chrome.runtime.sendMessage({ type: 'hls-done', ok: true, ...res }),
    e => chrome.runtime.sendMessage({ type: 'hls-done', ok: false, error: e.name === 'AbortError' ? '취소했습니다.' : e.message }),
  ).catch(() => {});
});
