// 스트리밍(HLS) 영상 받기: 조각 목록(m3u8)을 읽어 조각을 모두 받고 하나의 MP4로 합친다.
// 숨겨진 확장 페이지(offscreen.html)에서 돌아간다. 진행 상황과 결과는 배경(background)에 메시지로 알린다.
//
// 지원: 영상과 소리가 한 조각에 함께 든 HLS (TS 조각은 MP4로 바꿔 담고, MP4 조각은 그대로 이어 붙임),
//       열쇠가 공개된 AES-128 암호화.
//       중간에 광고 등이 끼어 시간이 새로 시작되는 목록(TS 조각)은 시간을 이어 붙여 담는다.
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
  let variant = null, dur = 0, range = null, prevEnd = 0, key = null, seq = 0, map = null, disc = false;
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
    else if (l === '#EXT-X-DISCONTINUITY') disc = true; // 여기서부터 시간이 새로 시작된다 (끼워 넣은 광고 등)
    else if (l === '#EXT-X-ENDLIST') out.ended = true;
    else if (!l.startsWith('#')) {
      if (variant) {
        out.variants.push({ url: abs(l), bandwidth: Number(variant.BANDWIDTH) || 0, resolution: variant.RESOLUTION || '', audio: variant.AUDIO || '' });
        variant = null;
      } else {
        out.segments.push({ url: abs(l), dur, range, key, seq: seq + out.segments.length, map, disc: disc && out.segments.length > 0 });
        out.total += dur;
        disc = false;
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

// 조각 목록 후보들 중에서 받을 것을 고른다.
// 한 탭에서 영상을 여러 개 보면 목록도 여러 개 쌓인다. 지금 보는 영상의 길이(hint, 초)와 맞는 것을 먼저 찾고,
// 없으면 가장 최근에 불러온 화질 목록(마스터)의 가장 높은 화질, 그것도 없으면 가장 긴 목록을 고른다.
async function pickPlaylist(urls, hint, signal) {
  const lists = [];
  for (const url of [...urls].reverse().slice(0, 8)) { // 최근에 불러온 것부터
    try { lists.push({ url, pl: parsePlaylist(await getText(url, signal), url) }); } catch (e) { if (signal.aborted) throw e; }
  }
  if (!lists.length) throw new Error('스트리밍 목록을 읽지 못했습니다.');
  const inMaster = new Set(lists.flatMap(x => x.pl.variants.map(v => v.url)));
  const cands = [];
  for (const x of lists) {
    if (x.pl.variants.length) {
      const best = [...x.pl.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
      const separateAudio = !!best.audio && x.pl.audio.some(a => a.group === best.audio && a.uri);
      try { cands.push({ master: true, separateAudio, quality: best.resolution, pl: parsePlaylist(await getText(best.url, signal), best.url) }); }
      catch (e) { if (signal.aborted) throw e; }
    } else if (x.pl.segments.length && !inMaster.has(x.url)) cands.push({ master: false, quality: '', pl: x.pl }); // 화질 목록에 딸린 것은 위에서 대표로 다룬다
  }
  const near = c => Math.abs(c.pl.total - hint) <= Math.max(2, hint * 0.03);
  const pick = (hint > 0 && cands.find(c => c.pl.segments.length && near(c)))
    || cands.find(c => c.master)
    || [...cands].sort((a, b) => b.pl.total - a.pl.total)[0];
  if (!pick) throw new Error('받을 영상 조각이 없습니다.');
  if (pick.separateAudio) throw new Error('영상과 소리가 따로 오는 방식이라 아직 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
  if (!pick.pl.segments.length) throw new Error('받을 영상 조각이 없습니다. 영상을 다시 재생한 뒤 눌러 주세요.');
  return pick;
}

// AES-128: 조각마다 정해진 열쇠와 초기값(IV)으로 푼다. IV가 없으면 조각 번호를 쓴다(HLS 규칙).
const keyCache = new Map();
async function decrypt(bytes, seg, signal) {
  const k = seg.key;
  // 여러 조각을 한꺼번에 풀어도 열쇠는 한 번만 받도록, 받는 중인 작업(promise)을 넣어 둔다
  if (!keyCache.has(k.uri)) {
    keyCache.set(k.uri, getBytes(k.uri, null, signal).then(raw => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
  }
  const iv = new Uint8Array(16);
  if (k.iv) { const hex = k.iv.replace(/^0x/i, '').padStart(32, '0'); for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16); }
  else new DataView(iv.buffer).setUint32(12, seg.seq);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await keyCache.get(k.uri), bytes));
}

// MP4 초기화 정보에서 "화면 크기 | 소리 형식"만 뽑는다. 이어 붙이는 부분끼리 이것이 같아야 한 파일로 재생된다.
function initSig(init) {
  const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const kids = (from, to) => {
    const out = [];
    for (let p = from; p + 8 <= to;) {
      const size = dv.getUint32(p);
      if (size < 8 || p + size > to) break;
      out.push({ type: String.fromCharCode(init[p + 4], init[p + 5], init[p + 6], init[p + 7]), from: p + 8, to: p + size });
      p += size;
    }
    return out;
  };
  const find = (list, type) => list.find(b => b.type === type);
  const moov = find(kids(0, init.byteLength), 'moov');
  if (!moov) return '';
  const sigs = [];
  for (const trak of kids(moov.from, moov.to).filter(b => b.type === 'trak')) {
    const tk = kids(trak.from, trak.to);
    const tkhd = find(tk, 'tkhd'), mdia = find(tk, 'mdia');
    if (!tkhd || !mdia) continue;
    const md = kids(mdia.from, mdia.to);
    const hdlr = find(md, 'hdlr'), minf = find(md, 'minf');
    const kind = hdlr ? String.fromCharCode(...init.subarray(hdlr.from + 8, hdlr.from + 12)) : '';
    if (kind === 'vide') sigs.push(`v${dv.getUint16(tkhd.to - 8)}x${dv.getUint16(tkhd.to - 4)}`);
    else if (kind === 'soun') {
      const stbl = minf && find(kids(minf.from, minf.to), 'stbl');
      const stsd = stbl && find(kids(stbl.from, stbl.to), 'stsd');
      sigs.push('a' + (stsd ? [...init.subarray(stsd.from, stsd.to)].map(x => x.toString(16).padStart(2, '0')).join('') : ''));
    }
  }
  return sigs.sort().join('|');
}

async function hlsDownload(urls, hint, report) {
  const ctl = new AbortController();
  hlsAbort = ctl;
  const signal = ctl.signal;
  keyCache.clear();
  const { pl, quality } = await pickPlaylist(urls, hint, signal);
  if (!pl.ended) throw new Error('생방송처럼 끝이 정해지지 않은 스트리밍은 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
  const bad = pl.segments.find(s => s.key && (s.key.method !== 'AES-128' || s.key.format !== 'identity' || !s.key.uri));
  if (bad) throw new Error('DRM으로 보호된 영상이라 받을 수 없습니다.');
  if (new Set(pl.maps.map(m => m.url + (m.range ? m.range.start : ''))).size > 1) throw new Error('중간에 형식이 바뀌는 스트리밍이라 받을 수 없습니다. 위의 녹화를 이용해 주세요.');

  const total = pl.segments.length, parts = [];
  let bytes = 0, done = 0;
  const isFmp4 = pl.maps.length > 0;
  if (isFmp4 && pl.segments.some(s => s.disc)) throw new Error('중간에 시간이 새로 시작되는 스트리밍이라 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
  // 받은 조각은 바로 Blob으로 바꿔 쌓는다. 큰 영상도 메모리에 통째로 들고 있지 않고 브라우저가 디스크로 넘길 수 있다.
  const keep = u8 => parts.push(new Blob([u8]));
  if (isFmp4) keep(await getBytes(pl.maps[0].url, pl.maps[0].range, signal));
  // TS 조각은 MP4 조각으로 바꾼다. 맨 처음 나온 초기화 정보만 앞에 두고 나머지는 차례로 이어 붙인다.
  // 중간에 시간이 새로 시작되는 곳(끼워 넣은 광고 등)에서는 변환기를 새로 만들어, 앞에서 담은 것이 끝난 자리에서 이어지게 한다.
  let tm = null, gotInit = false, sig = '', changed = false;
  let base = 0, written = 0, frags = 0; // base·ends: 1초 = 90000
  let first = {}, ends = {};
  const makeTm = () => {
    const t = new (muxjs.mp4 || muxjs).Transmuxer({ remux: true, baseMediaDecodeTime: base, firstSequenceNumber: frags }); // mp4 전용 묶음에서는 muxjs 자체가 mp4 모듈이다
    t.on('data', seg => {
      // 화면 크기나 소리 형식이 앞부분과 다르면 한 파일에 그대로 이어 담을 수 없다
      const now = initSig(seg.initSegment);
      if (!gotInit) { keep(seg.initSegment); gotInit = true; sig = now; } else if (now !== sig) changed = true;
      keep(seg.data); frags++;
    });
    for (const kind of ['video', 'audio']) {
      t.on(`${kind}TimingInfo`, i => {
        const st = i?.start?.dts ?? i?.start, en = i?.end?.dts ?? i?.end;
        if (!(en >= st)) return;
        first[kind] ??= st;
        ends[kind] = base + (en - first[kind]);
      });
    }
    return t;
  };
  if (!isFmp4) tm = makeTm();
  const BATCH = 4; // 한 번에 4개씩 받고, 순서대로 처리한다
  for (let i = 0; i < total; i += BATCH) {
    const group = pl.segments.slice(i, i + BATCH);
    const got = await Promise.all(group.map(async s => {
      const b = await getBytes(s.url, s.range, signal);
      return s.key ? decrypt(b, s, signal) : b;
    }));
    for (const [j, b] of got.entries()) {
      const s = group[j];
      bytes += b.length;
      if (bytes > HLS_MAX_BYTES) throw new Error('영상이 너무 커서(2GB 초과) 한 번에 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
      if (isFmp4) { keep(b); continue; }
      if (s.disc) {
        // 시간이 새로 시작되는 조각: 앞에서 담은 영상·소리가 끝난 자리를 새 기준으로 삼는다
        base = Math.max(Math.round(written * 90000), ends.video || 0, ends.audio || 0);
        first = {};
        tm = makeTm();
      }
      tm.push(b); tm.flush();
      if (changed) throw new Error('중간에 화면 크기나 소리 형식이 바뀌는 스트리밍(다른 영상이 끼어 있는 경우 등)이라 한 파일로 합칠 수 없습니다. 위의 녹화를 이용해 주세요.');
      written += s.dur;
    }
    done += group.length;
    report({ done, total, bytes });
  }
  if (!isFmp4 && !gotInit) throw new Error('영상 조각을 MP4로 바꾸지 못했습니다. 위의 녹화를 이용해 주세요.');
  const blob = new Blob(parts, { type: 'video/mp4' });
  return { url: URL.createObjectURL(blob), size: blob.size, seconds: Math.round(pl.total), quality };
}

// 배경이 맡긴 작업 하나를 끝까지 돌린다. msg.job은 작업 번호로, 소식을 보낼 때마다 붙여 배경이 지난 작업의 것과 구분한다.
let hlsActive = 0;
async function hlsRun(msg) {
  hlsActive++;
  let last = 0, state = { done: 0, total: 0, bytes: 0 };
  const tell = () => { last = Date.now(); chrome.runtime.sendMessage({ type: 'hls-progress', job: msg.job, ...state }).catch(() => {}); };
  // 조각 하나가 오래 걸려도 "아직 살아 있음"을 알린다. 배경은 이 소식이 오래 끊기면 작업이 죽은 것으로 본다.
  const beat = setInterval(tell, 10_000);
  try {
    const res = await hlsDownload(msg.urls, msg.hint, p => {
      state = p;
      // 진행 상황은 0.5초에 한 번쯤만 알린다 (알릴 때마다 배경이 깨어 있게 되어 긴 작업 중 잠들지 않는다)
      if (Date.now() - last > 500 || p.done === p.total) tell();
    });
    await chrome.runtime.sendMessage({ type: 'hls-done', job: msg.job, ok: true, ...res });
  } catch (e) {
    await chrome.runtime.sendMessage({ type: 'hls-done', job: msg.job, ok: false, error: e.name === 'AbortError' ? '취소했습니다.' : e.message }).catch(() => {});
  } finally { clearInterval(beat); hlsActive--; }
}

let hlsQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return; // 배경이 보낸 것만
  if (msg.type === 'offscreen-hls-cancel') { hlsAbort?.abort(); sendResponse({ active: hlsActive > 0 }); return; }
  if (msg.type !== 'offscreen-hls') return;
  // 한 번에 하나만: 앞선 작업이 남아 있으면 그만두게 하고, 정리가 끝난 뒤에 시작한다
  hlsAbort?.abort();
  hlsQueue = hlsQueue.then(() => hlsRun(msg)).catch(() => {});
});
