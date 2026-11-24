// 스트리밍 영상 받기: 조각 목록(HLS m3u8 · DASH mpd)을 읽어 조각을 모두 받고 MP4 한 개로 합친다.
// 숨겨진 확장 페이지(offscreen.html)에서 돌아간다. 합치기는 stream-mp4.js, TS 조각 변환은 mux.js가 맡는다.
//
// 지원
//  - HLS: 영상·소리가 함께 든 것, 따로 오는 것(소리 언어 선택), TS·MP4·AAC 조각, 열쇠가 공개된 AES-128,
//         중간에 광고 등이 끼어 시간이 새로 시작되는 것, 생방송(정지할 때까지 받기)
//  - DASH: SegmentTemplate(번호·시각), SegmentList, SegmentBase(한 파일 + 색인)
//  - 화질 고르기, 끊긴 조각 다시 받기, 큰 영상은 디스크에 바로 쓰기
// 미지원: DRM(Widevine·PlayReady·FairPlay 등)으로 보호된 영상, WebM 조각, 생방송 DASH

const BATCH = 6;                         // 한 번에 받는 조각 수
const MAX_DISK = 100 * 1024 ** 3;        // 디스크에 쓸 때 최대 크기
const MAX_MEMORY = 4 * 1024 ** 3;        // 메모리에 모을 때 최대 크기
const LIVE_MAX_MS = 6 * 3600_000;        // 생방송은 최대 6시간까지
const LIVE_EDGE = 3;                     // 생방송은 가장 최근 조각 3개 전부터 받는다

// ── 받기 (실패하면 몇 번 더) ──
class HttpError extends Error { constructor(status) { super(`서버 응답 ${status}`); this.status = status; } }
const wait = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('취소', 'AbortError')); }, { once: true });
});

// 네트워크 문제로 끝내 받지 못한 경우. 이미 받은 내용이 있으면 버리지 않고 그만큼 저장하는 데 쓴다.
class NetError extends Error {}
const IDLE_MS = 30_000; // 이만큼 아무 데이터도 오지 않으면 끊긴 것으로 보고 다시 요청한다

async function fetchOnce(url, { range, signal, fresh }) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let timer = setTimeout(stop, IDLE_MS);
  const alive = () => { clearTimeout(timer); timer = setTimeout(stop, IDLE_MS); };
  try {
    const r = await fetch(url, { credentials: 'include', signal: ctl.signal, cache: fresh ? 'no-store' : 'default',
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {} });
    if (!r.ok) { r.body?.cancel().catch(() => {}); return { status: r.status }; }
    // 조금씩 읽으며, 데이터가 오는 동안에는 기다린다 (큰 조각도 끊기지 않게)
    // 범위를 무시하고 파일 전체를 보내는 서버라면 필요한 곳까지만 읽고 끊는다 (큰 파일을 통째로 받지 않게)
    const ignored = range && r.status === 200;
    const need = ignored ? range.end + 1 : Infinity;
    const chunks = [];
    let size = 0;
    const reader = r.body.getReader();
    while (size < need) {
      const { done, value } = await reader.read();
      if (done) break;
      alive();
      chunks.push(value); size += value.byteLength;
    }
    if (size >= need) reader.cancel().catch(() => {});
    let u8 = chunks.length === 1 ? chunks[0] : new Uint8Array(size);
    if (chunks.length !== 1) { let p = 0; for (const c of chunks) { u8.set(c, p); p += c.byteLength; } }
    if (ignored) u8 = u8.subarray(range.start, Math.min(size, range.end + 1));
    const total = Number((r.headers.get('content-range') || '').split('/')[1]) || (ignored || !range ? Number(r.headers.get('content-length')) || 0 : 0);
    return { status: r.status, u8, total };
  } catch (e) {
    if (signal?.aborted) throw new DOMException('취소', 'AbortError');
    throw ctl.signal.aborted ? new Error('응답이 너무 오래 없습니다') : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

async function fetchRetry(url, { range = null, signal, text = false, fresh = false, meta = false } = {}) {
  let last;
  for (let i = 0; i < 5; i++) {
    if (i) await wait([0, 800, 2500, 6000, 12000][i], signal);
    try {
      const r = await fetchOnce(url, { range, signal, fresh });
      if (!r.u8) {
        last = new HttpError(r.status);
        // 주소가 틀렸거나 권한이 없는 경우는 한 번만 더 해 보고 그만둔다 (잠깐의 서버 오류는 여러 번)
        if ([400, 401, 403, 404, 410].includes(r.status) && i >= 1) break;
        continue;
      }
      if (text) return new TextDecoder().decode(r.u8);
      const u8 = r.u8;
      return meta ? { u8, total: r.total } : u8;
    } catch (e) {
      if (signal?.aborted) throw new DOMException('취소', 'AbortError');
      last = e;
    }
  }
  const err = new NetError(last?.status ? last.message : `받기 실패: ${last?.message || '네트워크 오류'}`);
  err.status = last?.status;
  throw err;
}

// ── HLS 목록 읽기 ──
const attrsOf = s => {
  const o = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
};
function byteRange(spec, prevEnd) {
  const [len, off] = spec.split('@').map(Number);
  const start = Number.isFinite(off) ? off : prevEnd;
  return { start, end: start + len - 1 };
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('스트리밍 목록 형식이 아닙니다.');
  const abs = u => new URL(u, baseUrl).href;
  const out = { url: baseUrl, variants: [], media: [], segments: [], ended: false, total: 0, target: 0, live: false };
  let variant = null, dur = 0, range = null, prevEnd = 0, key = null, seq = 0, map = null, disc = false, gap = false;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-STREAM-INF:')) variant = attrsOf(l.slice(18));
    else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrsOf(l.slice(13));
      out.media.push({ type: a.TYPE, group: a['GROUP-ID'], uri: a.URI ? abs(a.URI) : '', name: a.NAME || '', lang: a.LANGUAGE || '', def: a.DEFAULT === 'YES' });
    } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) out.target = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrsOf(l.slice(11));
      key = !a.METHOD || a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? abs(a.URI) : '', iv: a.IV || '', format: a.KEYFORMAT || 'identity' };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrsOf(l.slice(11));
      map = { url: abs(a.URI), range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) { range = byteRange(l.slice(17), prevEnd); prevEnd = range.end + 1; }
    else if (l === '#EXT-X-DISCONTINUITY') disc = true; // 여기서부터 시간이 새로 시작된다 (끼워 넣은 광고 등)
    else if (l === '#EXT-X-GAP') gap = true; // 비어 있는 조각
    else if (l === '#EXT-X-ENDLIST') out.ended = true;
    else if (!l.startsWith('#')) {
      if (variant) {
        out.variants.push({ url: abs(l), bandwidth: Number(variant['AVERAGE-BANDWIDTH'] || variant.BANDWIDTH) || 0, resolution: variant.RESOLUTION || '',
          codecs: variant.CODECS || '', audio: variant.AUDIO || '' });
        variant = null;
      } else {
        if (!gap) {
          out.segments.push({ url: abs(l), dur, range, key, seq, map, disc: disc && out.segments.length > 0, start: out.total });
          disc = false;
        } else disc = true; // 빈 조각을 건너뛰면 그 뒤는 시간이 이어지지 않는다
        out.total += dur;
        seq++;
        if (!range) prevEnd = 0;
        range = null; gap = false;
      }
    }
  }
  out.live = !out.variants.length && !out.ended;
  return out;
}

// ── DASH 목록 읽기 ──
function isoSeconds(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec] = m.map(x => Number(x) || 0);
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + sec;
}
const parseRange = s => { const m = /^(\d+)-(\d+)$/.exec(String(s || '').trim()); return m ? { start: +m[1], end: +m[2] } : null; };
const fillTemplate = (tpl, vars) => tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0(\d+)d)?\$/g,
  (m, id, width) => (id ? (width ? String(vars[id]).padStart(+width, '0') : String(vars[id])) : '$'));

function parseMpd(text, mpdUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('스트리밍 목록 형식이 아닙니다.');
  const kids = (el, name) => (el ? [...el.children].filter(c => c.localName === name) : []);
  const kid = (el, name) => kids(el, name)[0] || null;
  const baseOf = (el, base) => { const b = kid(el, 'BaseURL'); return b ? new URL(b.textContent.trim(), base).href : base; };
  const live = mpd.getAttribute('type') === 'dynamic';
  const total = isoSeconds(mpd.getAttribute('mediaPresentationDuration'));
  const base = baseOf(mpd, mpdUrl);

  // 기간(Period)이 여러 개일 수 있다(장 나눔, 앞뒤로 붙은 광고 등). 고를 수 있는 화질은 가장 긴 기간(본편)을 기준으로 보여 주고,
  // 받을 때는 같은 형식의 화질이 있는 기간을 모두 차례로 이어 붙인다.
  let prevEnd = 0;
  const periods = kids(mpd, 'Period').map((p, i, all) => {
    const start = p.hasAttribute('start') ? isoSeconds(p.getAttribute('start')) : prevEnd;
    const next = all[i + 1]?.hasAttribute('start') ? isoSeconds(all[i + 1].getAttribute('start')) : 0;
    // 길이: 적혀 있으면 그것, 없으면 다음 기간 시작까지, 마지막 기간이면 전체 길이까지
    const dur = isoSeconds(p.getAttribute('duration')) || (next > start ? next - start : !all[i + 1] && total > start ? total - start : 0);
    prevEnd = start + dur;
    return { el: p, dur, reps: repsOf(p) };
  });
  if (!periods.length) throw new Error('스트리밍 목록에 영상이 없습니다.');
  const main = [...periods].sort((a, b) => b.dur - a.dur)[0];
  return { live, duration: periods.reduce((n, p) => n + p.dur, 0) || total, mainDuration: main.dur, reps: main.reps, periods };

  function repsOf(period) {
  const pBase = baseOf(period, base);
  const reps = [];
  kids(period, 'AdaptationSet').forEach((as, ai) => {
    const asBase = baseOf(as, pBase);
    const asProtected = kids(as, 'ContentProtection').length > 0;
    for (const rep of kids(as, 'Representation')) {
      const get = a => rep.getAttribute(a) ?? as.getAttribute(a);
      const mime = get('mimeType') || '', codecs = get('codecs') || '';
      const ct = as.getAttribute('contentType') || mime.split('/')[0];
      let kind = ct === 'video' || ct === 'audio' ? ct : /^(avc|hvc|hev|vp0?9|av01)/.test(codecs) ? 'video' : /^(mp4a|opus|ac-3|ec-3|flac)/.test(codecs) ? 'audio' : '';
      if (!kind) continue;
      reps.push({
        key: `${ai}:${rep.getAttribute('id') || reps.length}`, kind, as: ai, mime, codecs,
        bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
        width: Number(get('width')) || 0, height: Number(get('height')) || 0,
        lang: as.getAttribute('lang') || '', label: kid(as, 'Label')?.textContent || as.getAttribute('label') || '',
        role: kid(as, 'Role')?.getAttribute('value') || '',
        protected: asProtected || kids(rep, 'ContentProtection').length > 0,
        webm: /webm/.test(mime),
        levels: [period, as, rep], base: baseOf(rep, asBase), repId: rep.getAttribute('id') || '',
      });
    }
  });
  return reps;
  }
}

// 다른 기간에서 고른 화질과 같은 것 찾기: 종류·코덱·화면 높이(소리면 언어)가 같고 대역폭이 가장 가까운 것
function sameRep(reps, r) {
  const fam = c => String(c || '').split('.')[0];
  const cands = reps.filter(x => x.kind === r.kind && !x.protected && !x.webm && fam(x.codecs) === fam(r.codecs)
    && (r.kind === 'video' ? x.height === r.height : (x.lang || '') === (r.lang || '')));
  return cands.sort((a, b) => Math.abs(a.bandwidth - r.bandwidth) - Math.abs(b.bandwidth - r.bandwidth))[0] || null;
}

// DASH 한 화질의 조각 목록 만들기
async function dashSegments(rep, periodDur, signal) {
  const pick = name => rep.levels.map(l => [...l.children].find(c => c.localName === name)).filter(Boolean);
  const attrOf = els => a => { let v = null; for (const e of els) if (e.hasAttribute(a)) v = e.getAttribute(a); return v; };
  const childOf = (els, name) => { let v = null; for (const e of els) { const c = [...e.children].find(x => x.localName === name); if (c) v = c; } return v; };
  const abs = u => new URL(u, rep.base).href;
  const vars = { RepresentationID: rep.repId, Bandwidth: rep.bandwidth };

  const tpl = pick('SegmentTemplate');
  if (tpl.length) {
    const attr = attrOf(tpl);
    const ts = Number(attr('timescale')) || 1, pto = Number(attr('presentationTimeOffset')) || 0;
    const first = Number(attr('startNumber') ?? 1);
    const media = attr('media');
    if (!media) throw new Error('DASH 조각 주소를 알 수 없습니다.');
    const initT = attr('initialization');
    const init = initT ? { url: abs(fillTemplate(initT, vars)), range: null } : null;
    const segs = [];
    const add = (n, t, d) => segs.push({ url: abs(fillTemplate(media, { ...vars, Number: n, Time: t })), range: null, start: (t - pto) / ts, dur: d / ts, map: init });
    const timeline = childOf(tpl, 'SegmentTimeline');
    if (timeline) {
      let t = 0, n = first;
      const S = [...timeline.children].filter(c => c.localName === 'S');
      S.forEach((s, i) => {
        if (s.hasAttribute('t')) t = Number(s.getAttribute('t'));
        const d = Number(s.getAttribute('d'));
        let r = Number(s.getAttribute('r') || 0);
        if (r < 0) { // 다음 항목 또는 기간 끝까지 반복
          const next = S[i + 1]?.hasAttribute('t') ? Number(S[i + 1].getAttribute('t')) : pto + periodDur * ts;
          r = Math.max(0, Math.ceil((next - t) / d) - 1);
        }
        for (let k = 0; k <= r; k++) { add(n++, t, d); t += d; }
      });
    } else {
      const d = Number(attr('duration'));
      if (!d || !periodDur) throw new Error('DASH 조각 길이를 알 수 없습니다.');
      const count = Math.ceil(periodDur * ts / d - 1e-6);
      for (let i = 0; i < count; i++) add(first + i, pto + i * d, d);
    }
    return segs;
  }

  const list = pick('SegmentList');
  if (list.length) {
    const attr = attrOf(list);
    const ts = Number(attr('timescale')) || 1, d = Number(attr('duration')) || 0;
    const initEl = childOf(list, 'Initialization');
    const init = initEl ? { url: abs(initEl.getAttribute('sourceURL') || rep.base), range: parseRange(initEl.getAttribute('range')) } : null;
    const urls = list.flatMap(l => [...l.children].filter(c => c.localName === 'SegmentURL'));
    return urls.map((u, i) => ({ url: abs(u.getAttribute('media') || rep.base), range: parseRange(u.getAttribute('mediaRange')),
      start: i * d / ts, dur: d / ts, map: init }));
  }

  // 한 파일로 된 경우(SegmentBase): 색인(sidx)을 읽어 조각 위치를 알아낸다. 색인이 없으면 파일 전체를 한 번에 받는다.
  const sb = pick('SegmentBase');
  const attr = attrOf(sb);
  const index = parseRange(attr('indexRange'));
  const initEl = childOf(sb, 'Initialization');
  // 색인이 없을 때: 파일 전체를 16MB씩 나눠 받는다 (큰 파일도 메모리에 통째로 올리지 않게). 받은 조각은 상자 단위로 이어 붙여 넘긴다.
  const wholeFile = async () => {
    const head = await fetchRetry(rep.base, { range: { start: 0, end: 0 }, signal, meta: true });
    const total = head.total;
    if (!total) return [{ url: rep.base, range: null, start: 0, dur: periodDur, map: null }];
    const STEP = 16 * 1024 ** 2, out = [];
    for (let p = 0; p < total; p += STEP) {
      const end = Math.min(total, p + STEP) - 1;
      out.push({ url: rep.base, range: { start: p, end }, start: periodDur * p / total, dur: periodDur * (end - p + 1) / total, map: null, chunk: true, last: end === total - 1 });
    }
    return out;
  };
  if (!index) return wholeFile();
  const init = { url: rep.base, range: parseRange(initEl?.getAttribute('range')) || { start: 0, end: index.start - 1 } };
  const idx = await fetchRetry(rep.base, { range: index, signal });
  const sidx = boxes(idx).find(b => b.type === 'sidx');
  if (!sidx) return wholeFile();
  const dv = dvOf(idx), v1 = idx[sidx.from] === 1;
  const ts = dv.getUint32(sidx.from + 8);
  let p = sidx.from + (v1 ? 32 : 24); // 항목이 시작하는 곳 (바로 앞 2바이트가 항목 수)
  const firstOffset = v1 ? Number(dv.getBigUint64(sidx.from + 20)) : dv.getUint32(sidx.from + 16);
  const count = dv.getUint16(p - 2);
  let at = index.start + sidx.end + firstOffset, t = 0;
  const segs = [];
  for (let i = 0; i < count; i++, p += 12) {
    const ref = dv.getUint32(p), d = dv.getUint32(p + 4);
    if (ref >>> 31) return wholeFile(); // 색인이 여러 단계로 나뉜 경우
    const size = ref & 0x7fffffff;
    segs.push({ url: rep.base, range: { start: at, end: at + size - 1 }, start: t / ts, dur: d / ts, map: init });
    at += size; t += d;
  }
  return segs;
}

// ── 무엇을 받을지 정하기 ──
// 페이지가 불러온 목록 여럿 중에서 지금 보는 영상(hint: 길이 초)과 맞는 것, 없으면 가장 최근 것을 고르고
// 고를 수 있는 화질·소리 목록을 만든다.
const mbps = b => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}Mbps` : `${Math.round(b / 1e3)}kbps`);
function labelVariants(vs) {
  for (const v of vs) {
    const rate = v.bandwidth ? mbps(v.bandwidth) : '';
    v.label = v.audioOnly ? ['소리만', rate].filter(Boolean).join(' · ')
      : v.height ? [`${v.height}p`, rate].filter(Boolean).join(' · ') : rate || '기본 화질';
  }
  return vs;
}

async function loadPresentation(entries, hint, signal) {
  const texts = new Map();
  const getText = async url => { if (!texts.has(url)) texts.set(url, await fetchRetry(url, { signal, text: true })); return texts.get(url); };
  const cands = [];
  const inMaster = new Set();
  for (const { url, kind } of [...entries].reverse().slice(0, 10)) { // 최근에 불러온 것부터
    try {
      const text = await getText(url);
      const dash = kind === 'dash' || /<MPD[\s>]/.test(text.slice(0, 2000));
      if (dash) { cands.push(await dashPresentation(parseMpd(text, url), signal)); continue; }
      const pl = parsePlaylist(text, url);
      if (pl.variants.length) { pl.variants.forEach(v => inMaster.add(v.url)); cands.push(await hlsMaster(pl, getText, signal)); }
      else if (pl.segments.length) cands.push({ pl });
    } catch (e) { if (signal.aborted) throw e; if (/DRM/.test(e.message)) cands.push({ error: e }); }
  }
  // 화질 목록에 딸린 조각 목록은 화질 목록 쪽에서 대표로 다룬다
  const all = cands.map(c => (c.pl ? (inMaster.has(c.pl.url) ? null : hlsMedia(c.pl)) : c)).filter(Boolean);
  const ok = all.filter(c => !c.error);
  if (!ok.length) throw all.find(c => c.error)?.error || new Error('스트리밍 목록을 읽지 못했습니다. 영상을 다시 재생한 뒤 눌러 주세요.');
  const near = c => hint > 0 && !c.live && Math.abs(c.duration - hint) <= Math.max(2, hint * 0.03);
  return ok.find(near) || ok.find(c => c.master) || [...ok].sort((a, b) => b.duration - a.duration)[0];
}

function hlsMedia(pl) {
  const v = { id: pl.url, height: 0, bandwidth: 0, url: pl.url, audio: '' };
  return {
    kind: 'HLS', live: pl.live, duration: pl.total, master: false,
    variants: labelVariants([v]), audios: [], variant: v.id, audio: '',
    est: () => 0,
    build: async () => [hlsSource('v', pl)],
  };
}

async function hlsMaster(pl, getText, signal) {
  const seen = new Set();
  const variants = pl.variants.filter(v => !seen.has(v.url) && seen.add(v.url)).map(v => {
    const height = Number(v.resolution.split('x')[1]) || 0;
    const audioOnly = !height && !!v.codecs && !/avc|hvc|hev|vp0?9|av01/.test(v.codecs);
    return { ...v, id: v.url, height, audioOnly };
  }).sort((a, b) => a.audioOnly - b.audioOnly || b.height - a.height || b.bandwidth - a.bandwidth);
  const best = variants[0];
  const best_pl = parsePlaylist(await getText(best.url), best.url);
  if (best_pl.segments.some(s => s.key && (s.key.method !== 'AES-128' || s.key.format !== 'identity')))
    throw new Error('DRM으로 보호된 영상이라 받을 수 없습니다.');
  const renditions = group => pl.media.filter(m => m.type === 'AUDIO' && m.group === group && m.uri);
  const audios = renditions(best.audio).map(m => ({ id: m.uri, label: [m.name, m.lang].filter(Boolean).join(' · ') || '소리', def: m.def }));
  return {
    kind: 'HLS', live: best_pl.live, duration: best_pl.total, master: true,
    variants: labelVariants(variants), audios, variant: best.id, audio: (audios.find(a => a.def) || audios[0])?.id || '',
    est: id => ((variants.find(v => v.id === id) || best).bandwidth * best_pl.total) / 8,
    build: async (id, audioId) => {
      const v = variants.find(x => x.id === id) || best;
      const vpl = parsePlaylist(await getText(v.url), v.url);
      const out = [hlsSource('v', vpl)];
      const rs = renditions(v.audio);
      const a = rs.find(r => r.uri === audioId) || rs.find(r => r.def) || rs[0];
      if (a && a.uri !== v.url) out.push(hlsSource('a', parsePlaylist(await getText(a.uri), a.uri)));
      return out;
    },
  };
}

function hlsSource(name, pl) {
  if (pl.segments.some(s => s.key && (s.key.method !== 'AES-128' || s.key.format !== 'identity' || !s.key.uri)))
    throw new Error('DRM으로 보호된 영상이라 받을 수 없습니다.');
  if (!pl.segments.length && pl.ended) throw new Error('받을 영상 조각이 없습니다. 영상을 다시 재생한 뒤 눌러 주세요.');
  return { name, segments: pl.segments, live: pl.live ? { url: pl.url, target: pl.target || 6 } : null };
}

async function dashPresentation(m, signal) {
  if (m.live) throw new Error('생방송 DASH는 아직 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
  const usable = m.reps.filter(r => !r.protected && !r.webm);
  if (!usable.length) {
    if (m.reps.some(r => r.protected)) throw new Error('DRM으로 보호된 영상이라 받을 수 없습니다.');
    if (m.reps.some(r => r.webm)) throw new Error('WebM 형식 스트리밍은 아직 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
    throw new Error('받을 수 있는 영상이 없습니다.');
  }
  const vids = usable.filter(r => r.kind === 'video');
  const variants = labelVariants((vids.length ? vids : usable.filter(r => r.kind === 'audio').map(r => ({ ...r, audioOnly: true })))
    .map(r => ({ ...r, id: r.key })).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth));
  // 소리: 묶음(AdaptationSet)마다 가장 좋은 것 하나씩
  const byAs = new Map();
  for (const r of usable.filter(r => r.kind === 'audio')) if (!byAs.has(r.as) || byAs.get(r.as).bandwidth < r.bandwidth) byAs.set(r.as, r);
  const audios = vids.length ? [...byAs.values()].map(r => ({ id: r.key, label: [r.label, r.lang].filter(Boolean).join(' · ') || '소리', def: r.role === 'main', rep: r })) : [];
  const best = variants[0];
  return {
    kind: 'DASH', live: false, duration: m.duration, master: true,
    variants, audios, variant: best.id, audio: (audios.find(a => a.def) || audios[0])?.id || '',
    est: id => (((variants.find(v => v.id === id) || best).bandwidth + (audios[0]?.rep.bandwidth || 0)) * m.duration) / 8,
    build: async (id, audioId) => {
      const v = variants.find(x => x.id === id) || best;
      const a = v.audioOnly ? null : audios.find(x => x.id === audioId) || audios.find(x => x.def) || audios[0];
      // 기간마다 같은 화질을 찾아 이어 붙인다. 기간이 바뀌는 곳은 시간이 새로 시작될 수 있으므로 이어 붙임 표시를 한다.
      const out = [{ name: 'v', segments: [] }, ...(a ? [{ name: 'a', segments: [] }] : [])];
      let at = 0, skipped = 0;
      for (const p of m.periods) {
        const pv = p.reps.includes(v) ? v : sameRep(p.reps, v);
        const pa = a && (p.reps.includes(a.rep) ? a.rep : sameRep(p.reps, a.rep));
        if (!pv || (a && !pa)) { skipped += p.dur; continue; }
        // 구간 하나를 읽지 못해도(길이 정보가 없는 광고 구간 등) 나머지는 받는다
        let lists;
        try { lists = await Promise.all([pv, ...(a ? [pa] : [])].map(r => dashSegments(r, p.dur, signal))); } catch (e) {
          if (signal.aborted) throw e;
          skipped += p.dur || 1; continue;
        }
        lists.forEach((segs, k) => segs.forEach((g, i) => out[k].segments.push({ ...g, start: at + g.start, disc: i === 0 && out[k].segments.length > 0 })));
        at += p.dur;
      }
      if (!out[0].segments.length) throw new Error('받을 영상 조각이 없습니다.');
      out.skipped = skipped;
      return out;
    },
  };
}

// ── AES-128 풀기 ──
async function decrypt(bytes, seg, keys, signal) {
  const k = seg.key;
  // 여러 조각을 한꺼번에 풀어도 열쇠는 한 번만 받도록, 받는 중인 작업(promise)을 넣어 둔다
  if (!keys.has(k.uri)) keys.set(k.uri, fetchRetry(k.uri, { signal }).then(raw => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
  const iv = new Uint8Array(16);
  if (k.iv) { const hex = k.iv.replace(/^0x/i, '').padStart(32, '0'); for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16); }
  else new DataView(iv.buffer).setUint32(12, seg.seq);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await keys.get(k.uri), bytes));
}

// ── 입력 하나(영상 또는 소리)를 합치는 일꾼에게 넘기는 곳 ──
// TS·AAC 조각은 mux.js로 조각 MP4로 바꾼 뒤 넘긴다. 원래 시각을 그대로 두어(keepOriginalTimestamps)
// 따로 받은 영상과 소리의 시작점이 어긋나지 않게 한다.
function feeder(name, writer) {
  let format = null, tm = null, out = [], pending = null;
  const makeTm = () => {
    const t = new (muxjs.mp4 || muxjs).Transmuxer({ remux: true, keepOriginalTimestamps: true });
    t.on('data', seg => out.push(seg));
    return t;
  };
  return async (bytes, item) => {
    if (item.init) return writer.take(name, bytes);
    if (item.chunk) {
      // 한 파일을 나눠 받은 것: 앞에서 남은 부분과 이어 붙이고, 끝까지 온 상자만 넘긴다
      if (pending) { const u = new Uint8Array(pending.byteLength + bytes.byteLength); u.set(pending); u.set(bytes, pending.byteLength); bytes = u; }
      const list = boxes(bytes);
      const end = list.length ? list[list.length - 1].end : 0;
      pending = end < bytes.byteLength ? bytes.slice(end) : null;
      if (pending && pending.byteLength > 512 * 1024 ** 2) throw new Error('조각 MP4 형식이 아니어서 나눠 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
      bytes = bytes.subarray(0, end);
      // 조각으로 나뉘지 않은 일반 MP4는 이 방식으로 합칠 수 없다. 큰 부분을 다 받기 전에 바로 알린다.
      const moov = list.find(b => b.type === 'moov');
      if (moov && !child(bytes, moov, 'mvex')) throw new Error('조각 MP4가 아닌 일반 MP4라 이 방식으로 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
      if (!bytes.byteLength) return;
    }
    format ??= sniff(bytes);
    if (format === 'webm') throw new Error('WebM 형식 스트리밍은 아직 받을 수 없습니다. 위의 녹화를 이용해 주세요.');
    if (format === 'unknown') throw new Error('알 수 없는 조각 형식입니다. 위의 녹화를 이용해 주세요.');
    if (item.disc) { writer.markDisc(name); tm = null; }
    if (format === 'fmp4') return writer.take(name, bytes);
    tm ??= makeTm();
    out = [];
    tm.push(bytes); tm.flush();
    for (const seg of out) {
      const u8 = new Uint8Array(seg.initSegment.byteLength + seg.data.byteLength);
      u8.set(seg.initSegment); u8.set(seg.data, seg.initSegment.byteLength);
      await writer.take(name, u8);
    }
  };
}

// ── 작업 하나 ──
let current = null; // { ctl, stop, wake }

async function runJob(msg, report) {
  const ctl = new AbortController();
  const job = { ctl, stopped: false, wake: null, netError: null };
  current = job;
  try { return await runJobInner(msg, report, job); } finally { if (current === job) current = null; }
}

async function runJobInner(msg, report, job) {
  const { ctl } = job;
  const signal = ctl.signal;
  const entries = (msg.urls || []).map(u => (typeof u === 'string' ? { url: u, kind: /\.mpd(\?|$)/i.test(u) ? 'dash' : 'hls' } : u));
  const pres = await loadPresentation(entries, msg.hint || 0, signal);
  const variantId = pres.variants.some(v => v.id === msg.variant) ? msg.variant : pres.variant;
  const sources = await pres.build(variantId, msg.audio || pres.audio);
  const quality = pres.variants.find(v => v.id === variantId)?.label || '';

  const sink = await openSink();
  const cap = sink.disk ? MAX_DISK : MAX_MEMORY;
  try {
    const est = pres.live ? 0 : pres.est(variantId);
    if (sink.disk && est) {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate().catch(() => ({}));
      if (quota && est * 1.05 > quota - usage) throw new Error(`저장 공간이 부족합니다. (필요 약 ${fmtBytes(est)}, 남은 공간 약 ${fmtBytes(quota - usage)})`);
    }
    if (est > cap) throw new Error(`영상이 너무 큽니다(약 ${fmtBytes(est)}). 낮은 화질을 골라 주세요.`);
    const writer = new Mp4Writer(sink, sources.map(s => s.name));
    const feed = new Map(sources.map(s => [s.name, feeder(s.name, writer)]));
    const keys = new Map();
    const state = { done: 0, total: 0, live: pres.live };
    const tell = () => report({ done: state.done, total: state.total, bytes: sink.size, seconds: Math.round(writer.endSec), live: state.live, quality });

    // 받을 것들을 시간순으로 늘어놓고, 앞에서부터 몇 개씩 미리 받아 두며 차례대로 합친다
    // 네트워크 문제로 끝내 받지 못한 조각이 생기면 거기서 멈추고, 그때까지 받은 것을 저장한다(일부 저장).
    // 멈추거나 끝날 때는 미리 받기 시작한 요청도 함께 그만둔다.
    const process = async items => {
      const batch = new AbortController();
      const stopBatch = () => batch.abort();
      signal.addEventListener('abort', stopBatch, { once: true });
      const fetchOne = it => fetchRetry(it.url, { range: it.range, signal: batch.signal }).then(b => (it.key && !it.init ? decrypt(b, it, keys, batch.signal) : b));
      const inflight = [];
      let next = 0;
      try {
        for (let i = 0; i < items.length; i++) {
          if (job.stopped && !pres.live) break;
          while (inflight.length < BATCH && next < items.length) { const p = fetchOne(items[next++]); p.catch(() => {}); inflight.push(p); }
          let bytes;
          try { bytes = await inflight.shift(); } catch (e) {
            if (!(e instanceof NetError) || signal.aborted) throw e;
            job.netError = e; job.stopped = true;
            return;
          }
          await feed.get(items[i].src)(bytes, items[i]);
          if (!items[i].init) state.done++;
          if (sink.size > cap) throw new Error(`영상이 너무 커서(${fmtBytes(cap)} 초과) 더 받을 수 없습니다.`);
          tell();
        }
      } finally {
        stopBatch();
        signal.removeEventListener('abort', stopBatch);
      }
    };
    // 조각 MP4는 초기화 정보가 바뀌는 곳마다 먼저 받아 넘긴다
    const withInits = (src, segs, last) => {
      const out = [];
      for (const s of segs) {
        const key = s.map ? `${s.map.url}|${s.map.range?.start ?? ''}` : '';
        if (key && key !== last.map) { out.push({ src, init: true, url: s.map.url, range: s.map.range, start: s.start }); last.map = key; }
        out.push({ ...s, src });
      }
      return out;
    };
    const order = (a, b) => a.start - b.start || a.si - b.si || a.n - b.n;

    if (!pres.live) {
      let items = [];
      sources.forEach((s, si) => { items.push(...withInits(s.name, s.segments, {}).map((x, n) => ({ ...x, si, n }))); });
      items.sort(order);
      state.total = items.filter(x => !x.init).length;
      tell();
      await process(items);
    } else {
      // 생방송: 목록을 주기적으로 다시 읽어 새 조각을 이어 받는다. "정지 후 저장"을 누르거나 방송이 끝나면 멈춘다.
      const st = sources.map((s, si) => ({ s, si, last: -Infinity, start: 0, map: {}, ended: false, target: s.live?.target || 6, n: 0 }));
      const t0 = Date.now();
      let first = true;
      // 시작 지점: 첫 입력(영상)의 최근 조각 3개만큼 앞에서부터. 다른 입력(소리)은 같은 시간만큼을 받는다 (조각 길이가 달라도 맞게).
      const tail = (segs, sec) => { let acc = 0, i = segs.length; while (i > 0 && acc < sec - 0.5) acc += segs[--i].dur; return segs.slice(i); };
      const edgeSec = st[0].s.segments.slice(-LIVE_EDGE).reduce((n, g) => n + g.dur, 0);
      while (!job.stopped) {
        const batch = [];
        for (const x of st) {
          if (x.ended) continue;
          let pl;
          if (first) pl = { segments: x.s.segments, target: x.target, ended: false };
          else {
            try { pl = parsePlaylist(await fetchRetry(x.s.live.url, { signal, text: true, fresh: true }), x.s.live.url); } catch (e) {
              if (!(e instanceof NetError)) throw e;
              job.netError = e; job.stopped = true; break; // 목록을 더 읽을 수 없으면 그때까지 받은 것을 저장
            }
          }
          x.target = pl.target || x.target;
          let segs = pl.segments.filter(g => g.seq > x.last);
          const top = pl.segments.length ? pl.segments[pl.segments.length - 1].seq : x.last;
          if (x.last === -Infinity) segs = tail(segs, edgeSec || segs.slice(-LIVE_EDGE).reduce((n, g) => n + g.dur, 0));
          // 번호가 크게 줄었으면 방송 쪽에서 처음부터 다시 시작한 것이다. 조금만 줄었으면 오래된 목록을 받은 것이니 이번에는 건너뛴다.
          else if (top < x.last - Math.max(pl.segments.length, LIVE_EDGE) - 2) segs = pl.segments.map((g, i) => (i ? g : { ...g, disc: true }));
          else if (segs.length && segs[0].seq > x.last + 1) segs[0] = { ...segs[0], disc: true }; // 놓친 조각이 있으면 시간을 이어 붙인다
          for (const g of segs) { x.last = g.seq; }
          const timed = segs.map(g => { const o = { ...g, start: x.start }; x.start += g.dur; return o; });
          batch.push(...withInits(x.s.name, timed, x.map).map(o => ({ ...o, si: x.si, n: x.n++ })));
          if (pl.ended) x.ended = true;
        }
        first = false;
        batch.sort(order);
        await process(batch); // 읽기에 실패한 목록이 있어도 이미 모은 조각은 담는다
        if (job.netError) break;
        if (st.every(x => x.ended) || Date.now() - t0 > LIVE_MAX_MS) break;
        // 다음 조각이 올 때까지 기다린다 (정지를 누르면 바로 깬다)
        await Promise.race([wait(Math.max(1000, Math.min(...st.map(x => x.target)) * 500), signal), new Promise(r => { job.wake = r; })]);
      }
    }
    if (!writer.ready && !writer.held.length) throw job.netError || new Error(job.stopped ? '받은 내용이 없습니다.' : '영상 조각을 읽지 못했습니다.');
    const meta = await writer.finish();
    const res = await sink.finish();
    if (res.disk) diskFiles.set(res.url, res.disk);
    // 일부만 저장된 이유를 알려 준다 (네트워크 문제, 형식이 다른 기간을 건너뜀)
    const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const note = job.netError ? `연결 문제로 ${mmss(meta.seconds)}까지만 저장했습니다 (${job.netError.message})`
      : sources.skipped > 1 ? '형식이 다른 구간(광고 등)은 빼고 저장했습니다' : '';
    return { url: res.url, size: res.size, seconds: Math.round(meta.seconds), quality, audioOnly: meta.audioOnly, kind: pres.kind,
      partial: !!job.netError || (job.stopped && !pres.live), live: pres.live, note };
  } catch (e) {
    await sink.abort();
    if (e?.name === 'QuotaExceededError') throw new Error('컴퓨터의 저장 공간이 부족해 더 받을 수 없습니다.');
    throw e;
  }
}

const fmtBytes = b => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}GB` : `${Math.round(b / 1024 ** 2)}MB`);

// 받기 전에 고를 수 있는 화질·소리와 길이를 알려 준다
async function probe(msg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const entries = (msg.urls || []).map(u => (typeof u === 'string' ? { url: u, kind: /\.mpd(\?|$)/i.test(u) ? 'dash' : 'hls' } : u));
    const p = await loadPresentation(entries, msg.hint || 0, ctl.signal);
    return { ok: true, kind: p.kind, live: p.live, duration: Math.round(p.duration), variant: p.variant, audio: p.audio,
      variants: p.variants.map(v => ({ id: v.id, label: v.label })), audios: p.audios.map(a => ({ id: a.id, label: a.label })), est: p.est(p.variant) || 0 };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '목록을 읽는 데 너무 오래 걸립니다.' : e.message };
  } finally { clearTimeout(timer); }
}

// ── 배경(background)과 주고받기 ──
const diskFiles = new Map(); // 저장용 임시 주소 → 디스크 파일 이름
cleanDisk(); // 지난번에 남은 임시 파일 정리

async function hlsRun(msg) {
  let last = 0, state = { done: 0, total: 0, bytes: 0 };
  const send = () => { last = Date.now(); chrome.runtime.sendMessage({ type: 'hls-progress', job: msg.job, ...state }).catch(() => {}); };
  // 조각 하나가 오래 걸려도 "아직 살아 있음"을 알린다. 배경은 이 소식이 오래 끊기면 작업이 죽은 것으로 본다.
  const beat = setInterval(send, 10_000);
  try {
    const res = await runJob(msg, p => { state = p; if (Date.now() - last > 500 || p.done === p.total) send(); });
    await chrome.runtime.sendMessage({ type: 'hls-done', job: msg.job, ok: true, ...res });
  } catch (e) {
    await chrome.runtime.sendMessage({ type: 'hls-done', job: msg.job, ok: false, error: e.name === 'AbortError' ? '취소했습니다.' : e.message }).catch(() => {});
  } finally { clearInterval(beat); }
}

let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return; // 배경이 보낸 것만
  if (msg.type === 'offscreen-hls-cancel') { current?.ctl.abort(); sendResponse({ active: !!current }); return; }
  if (msg.type === 'offscreen-hls-stop') { if (current) { current.stopped = true; current.wake?.(); } sendResponse({ active: !!current }); return; }
  if (msg.type === 'offscreen-hls-probe') { probe(msg).then(sendResponse); return true; }
  if (msg.type === 'offscreen-revoke' && diskFiles.has(msg.url)) {
    // 지운 뒤에 답한다. 배경은 이 답을 기다렸다가 숨겨진 페이지를 닫는다 (임시 파일이 남지 않게).
    const name = diskFiles.get(msg.url);
    diskFiles.delete(msg.url);
    removeDisk(name).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type !== 'offscreen-hls') return;
  // 한 번에 하나만: 앞선 작업이 남아 있으면 그만두게 하고, 정리가 끝난 뒤에 시작한다
  current?.ctl.abort();
  queue = queue.then(() => hlsRun(msg)).catch(() => {});
});
