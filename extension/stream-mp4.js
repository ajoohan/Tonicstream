// 스트리밍 받기에 쓰는 MP4 도구: 조각(fMP4)을 읽고, 영상·소리처럼 따로 받은 것을 한 파일로 합쳐 쓴다.
// 숨겨진 확장 페이지(offscreen.html)에서 stream.js와 함께 돌아간다.
//
// 결과 파일은 "조각 MP4(fragmented MP4)"다. 앞에 전체 정보(moov), 뒤에 조각(moof+mdat)이 시간순으로 이어진다.
// 영상과 소리 조각을 시간순으로 번갈아 담아, 일반 동영상 플레이어에서도 끊김 없이 재생된다.

// ── 상자(box) 읽기 ──
const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
const dvOf = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// u8의 from~to 사이에 있는 상자 목록. 각 상자: { type, start(머리 포함 시작), from(내용 시작), end }
function boxes(u8, from = 0, to = u8.byteLength) {
  const dv = dvOf(u8), out = [];
  for (let p = from; p + 8 <= to;) {
    let size = dv.getUint32(p), hdr = 8;
    if (size === 1) { if (p + 16 > to) break; size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = to - p;
    if (size < hdr || p + size > to) break;
    out.push({ type: fourcc(u8, p + 4), start: p, from: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (u8, box, type) => boxes(u8, box.from, box.end).find(b => b.type === type) || null;
const children = (u8, box, type) => boxes(u8, box.from, box.end).filter(b => b.type === type);

function box(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  dvOf(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let p = 8;
  for (const x of parts) { out.set(x, p); p += x.byteLength; }
  return out;
}
const slice = (u8, b) => u8.slice(b.start, b.end); // 복사본

// ── 첫 바이트로 형식 알아보기 ──
function sniff(u8) {
  if (u8[0] === 0x47 && (u8.length < 189 || u8[188] === 0x47)) return 'ts';
  if (fourcc(u8, 0) === 'ID3\u0003' || fourcc(u8, 0).startsWith('ID3') || (u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0)) return 'aac';
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'webm';
  const t = fourcc(u8, 4);
  if (['ftyp', 'styp', 'moov', 'moof', 'sidx', 'emsg', 'prft', 'free', 'mdat'].includes(t)) return 'fmp4';
  return 'unknown';
}

// ── 초기화 정보(moov) 안의 트랙 ──
// { id, kind: 'vide'|'soun'|..., timescale, trak(복사본), trex(복사본|null), sig(같은 형식인지 비교용) }
function tracksOf(moovU8) {
  const moov = boxes(moovU8)[0];
  const mvex = child(moovU8, moov, 'mvex');
  const trexes = mvex ? children(moovU8, mvex, 'trex') : [];
  const out = [];
  for (const trak of children(moovU8, moov, 'trak')) {
    const tkhd = child(moovU8, trak, 'tkhd'), mdia = child(moovU8, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const dv = dvOf(moovU8);
    const v1 = moovU8[tkhd.from] === 1;
    const id = dv.getUint32(tkhd.from + (v1 ? 20 : 12));
    const mdhd = child(moovU8, mdia, 'mdhd'), hdlr = child(moovU8, mdia, 'hdlr');
    const timescale = mdhd ? dv.getUint32(mdhd.from + (moovU8[mdhd.from] === 1 ? 20 : 12)) : 90000;
    const kind = hdlr ? fourcc(moovU8, hdlr.from + 8) : '';
    const trex = trexes.find(t => dv.getUint32(t.from + 4) === id);
    const minf = child(moovU8, mdia, 'minf'), stbl = minf && child(moovU8, minf, 'stbl'), stsd = stbl && child(moovU8, stbl, 'stsd');
    const w = dv.getUint32(tkhd.end - 8) >>> 16, h = dv.getUint32(tkhd.end - 4) >>> 16;
    // 형식 비교용: 종류, 화면 크기, 코덱 이름, (소리면) 채널 수·샘플 빈도. 세부 설정 차이는 재생에 지장이 없어 보지 않는다.
    let sig = `${kind}:${w}x${h}:`;
    if (stsd && stsd.from + 16 <= stsd.end) {
      const e = stsd.from + 8; // 첫 번째 견본 설명 상자
      sig += fourcc(moovU8, e + 4);
      if (kind === 'soun' && e + 36 <= stsd.end) sig += `:${dv.getUint16(e + 24)}ch:${dv.getUint32(e + 32) >>> 16}`;
    }
    out.push({ id, kind, timescale: timescale || 90000, trak: slice(moovU8, trak), trex: trex ? slice(moovU8, trex) : null,
      defaultDur: trex ? dv.getUint32(trex.from + 12) : 0, sig, w, h });
  }
  return out;
}

// ── 결과 파일에 쓰기 ──
// 디스크(브라우저의 확장 전용 저장 공간)에 바로 쓴다. 쓸 수 없으면 메모리에 모은다.
const DISK_PREFIX = 'dl-';
async function openSink() {
  try {
    const dir = await navigator.storage.getDirectory();
    const name = `${DISK_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    let size = 0, closed = false;
    return {
      disk: true, name,
      get size() { return size; },
      async write(u8) { await w.write(u8); size += u8.byteLength; },
      async patch(pos, u8) { await w.write({ type: 'write', position: pos, data: u8 }); await w.seek(size); },
      async finish() { closed = true; await w.close(); return { url: URL.createObjectURL(await fh.getFile()), size, disk: name }; },
      async abort() { if (!closed) { closed = true; await w.abort().catch(() => {}); } await dir.removeEntry(name).catch(() => {}); },
    };
  } catch (e) {
    console.warn('디스크에 바로 쓰지 못해 메모리에 모읍니다', e);
    const parts = [];
    let size = 0, head = null;
    return {
      disk: false,
      get size() { return size; },
      async write(u8) { if (!head) head = u8; parts.push(head === u8 ? u8 : new Blob([u8])); size += u8.byteLength; },
      async patch(pos, u8) { if (head && pos + u8.byteLength <= head.byteLength) head.set(u8, pos); },
      async finish() { const blob = new Blob(parts.map(p => (p === head ? new Blob([head]) : p)), { type: 'video/mp4' }); return { url: URL.createObjectURL(blob), size: blob.size }; },
      async abort() { parts.length = 0; },
    };
  }
}

// 지난번에 정리되지 못한 파일(작업 중 숨겨진 페이지가 닫힌 경우 등)을 지운다
async function cleanDisk(keep = new Set()) {
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const [name] of dir.entries()) if (name.startsWith(DISK_PREFIX) && !keep.has(name)) await dir.removeEntry(name).catch(() => {});
  } catch {}
}
async function removeDisk(name) {
  try { await (await navigator.storage.getDirectory()).removeEntry(name); } catch {}
}

// ── 여러 입력을 한 파일로 합치는 일꾼 ──
// 입력(source)마다 초기화 정보와 조각을 넘겨받는다. 모든 입력의 초기화 정보와 첫 조각이 모이면
// 합친 초기화 정보를 쓰고, 그다음부터는 받는 대로 조각의 트랙 번호·시각·순번을 고쳐 이어 쓴다.
class Mp4Writer {
  constructor(sink, sourceNames) {
    this.sink = sink;
    this.sources = new Map(sourceNames.map(n => [n, { name: n, tracks: null, sig: '', dropped: false }]));
    this.held = []; // 준비되기 전에 들어온 조각들
    this.heldBytes = 0;
    this.ready = false;
    this.seq = 1;
    this.byKey = new Map(); // "입력:원래 트랙 번호" → 결과 트랙
    this.patches = [];
    this.endSec = 0;
    this.kinds = new Set();
  }

  // 받은 바이트(조각 MP4)를 넘긴다. 초기화 정보(moov)와 조각(moof+mdat)을 골라낸다.
  async take(name, u8) {
    const src = this.sources.get(name);
    const top = boxes(u8);
    for (let i = 0; i < top.length; i++) {
      const b = top[i];
      if (b.type === 'moov') this.setInit(src, slice(u8, b));
      else if (b.type === 'moof') {
        // 조각 = moof부터 뒤따르는 mdat까지 (사이에 낀 상자도 함께 두어야 데이터 위치가 맞는다)
        let end = b.end;
        for (let j = i + 1; j < top.length && top[j].type !== 'moof'; j++) { if (top[j].type === 'mdat') end = top[j].end; }
        if (end > b.end) await this.frag(src, u8.subarray(b.start, end));
      }
    }
  }

  setInit(src, moov) {
    const tracks = tracksOf(moov).filter(t => t.kind === 'vide' || t.kind === 'soun');
    const sig = tracks.map(t => t.sig).sort().join('|');
    if (src.tracks) {
      // 중간에 초기화 정보가 다시 오는 것은 흔하다(조각마다 붙는 경우). 형식이 그대로면 그냥 넘어간다.
      if (sig !== src.sig) throw new Error('중간에 화면 크기나 소리 형식이 바뀌는 영상이라 한 파일로 합칠 수 없습니다. 위의 녹화를 이용해 주세요.');
      return;
    }
    if (!tracks.length) throw new Error('영상 정보를 읽지 못했습니다.');
    src.tracks = tracks; src.sig = sig; src.moov = moov;
  }

  // 이 입력의 다음 조각부터는 시간이 새로 시작된다(끼워 넣은 광고 등). 앞에서 끝난 자리에 이어 붙인다.
  markDisc(name) {
    const src = this.sources.get(name);
    if (!this.ready) { this.held.push([src, null]); return; } // 모아 둔 조각 사이에 표시해 두었다가 쓸 때 반영
    for (const t of this.byKey.values()) if (t.src === src) t.pendingDisc = true;
  }

  async frag(src, unit) {
    if (src.dropped) return;
    if (!src.tracks) return; // 초기화 정보 없이 온 조각은 쓸 수 없다
    if (!this.ready) {
      // 첫 조각의 시각을 기록해 두고(모든 트랙의 시작점을 맞추는 데 쓴다) 준비될 때까지 모아 둔다
      src.firstTimes ??= new Map();
      for (const [id, t] of this.fragTimes(unit)) if (!src.firstTimes.has(id)) src.firstTimes.set(id, t);
      this.held.push([src, unit]);
      this.heldBytes += unit.byteLength;
      const all = [...this.sources.values()].filter(s => !s.dropped);
      // 소리가 안 오는 등 한쪽이 끝내 준비되지 않으면 너무 많이 모으지 않고 있는 것만으로 시작한다
      if (all.every(s => s.tracks && s.tracks.every(t => s.firstTimes?.has(t.id))) || this.heldBytes > 48 * 1024 ** 2) await this.start();
      return;
    }
    await this.writeFrag(src, unit);
  }

  // 조각 안의 트랙별 시작 시각(초)
  fragTimes(unit) {
    const out = new Map(), dv = dvOf(unit);
    const moof = boxes(unit)[0];
    for (const traf of children(unit, moof, 'traf')) {
      const tfhd = child(unit, traf, 'tfhd'), tfdt = child(unit, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const id = dv.getUint32(tfhd.from + 4);
      const raw = unit[tfdt.from] === 1 ? Number(dv.getBigUint64(tfdt.from + 4)) : dv.getUint32(tfdt.from + 4);
      out.set(id, raw);
    }
    return out;
  }

  async start() {
    this.ready = true;
    const srcs = [...this.sources.values()].filter(s => s.tracks && s.firstTimes?.size);
    for (const s of this.sources.values()) if (!srcs.includes(s)) s.dropped = true;
    if (!srcs.length) throw new Error('영상 조각을 읽지 못했습니다.');
    // 첫 입력(보통 영상)에 이미 소리가 들어 있으면 따로 받은 소리는 쓰지 않는다
    if (srcs[0].tracks.some(t => t.kind === 'soun')) for (const s of srcs.slice(1)) if (s.tracks.every(t => t.kind === 'soun')) s.dropped = true;
    const used = srcs.filter(s => !s.dropped);
    let nextId = 1;
    const tracks = [];
    for (const s of used) {
      for (const t of s.tracks) {
        if (!s.firstTimes.has(t.id)) continue; // 조각이 한 번도 오지 않은 트랙은 넣지 않는다
        const nt = { ...t, src: s, newId: nextId++, shift: 0, end: 0, pendingDisc: false };
        this.byKey.set(`${s.name}:${t.id}`, nt);
        tracks.push(nt);
        this.kinds.add(t.kind);
      }
    }
    // 모든 트랙의 시작을 가장 이른 트랙에 맞춘다 (원래 시각이 수십 시간인 생방송·DASH도 0초부터 시작하게)
    const origin = Math.min(...tracks.map(t => t.src.firstTimes.get(t.id) / t.timescale));
    for (const t of tracks) t.shift = -Math.round(origin * t.timescale);

    await this.sink.write(this.buildInit(used[0].moov, tracks));
    const held = this.held;
    this.held = [];
    for (const [s, unit] of held) {
      if (s.dropped) continue;
      if (unit) await this.writeFrag(s, unit);
      else for (const t of this.byKey.values()) if (t.src === s) t.pendingDisc = true;
    }
  }

  buildInit(firstMoov, tracks) {
    const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, ...[...'isomiso6iso2avc1mp41'].map(c => c.charCodeAt(0))]));
    const m = boxes(firstMoov)[0];
    const mvhdBox = child(firstMoov, m, 'mvhd');
    const mvhd = slice(firstMoov, mvhdBox);
    const mv = dvOf(mvhd), v1 = mvhd[8] === 1;
    this.timescale = mv.getUint32(v1 ? 28 : 20) || 1000;
    // 전체 길이는 다 받은 뒤에 적는다
    if (v1) mv.setBigUint64(32, 0n); else mv.setUint32(24, 0);
    mv.setUint32(mvhd.byteLength - 4, tracks.length + 1); // 다음 트랙 번호
    const traks = tracks.map(t => {
      const trak = t.trak.slice(), d = dvOf(trak);
      const tk = boxes(trak, 8).find(b => b.type === 'tkhd');
      const tv1 = trak[tk.from] === 1;
      d.setUint32(tk.from + (tv1 ? 20 : 12), t.newId);
      // 트랙 길이는 비워 둔다(조각 MP4의 관례). 원래 값이 "알 수 없음(FFFFFFFF)"이면 플레이어가 길이를 잘못 보여 준다.
      if (tv1) d.setBigUint64(tk.from + 28, 0n); else d.setUint32(tk.from + 20, 0);
      const mdia = boxes(trak, 8).find(b => b.type === 'mdia');
      const mdhd = mdia && child(trak, mdia, 'mdhd');
      if (mdhd) { if (trak[mdhd.from] === 1) d.setBigUint64(mdhd.from + 24, 0n); else d.setUint32(mdhd.from + 16, 0); }
      return trak;
    });
    const mehd = box('mehd', new Uint8Array(12)); mehd[8] = 1; // 판 1: 길이 8바이트
    const trexes = tracks.map(t => {
      const trex = t.trex ? t.trex.slice() : box('trex', new Uint8Array(24));
      const d = dvOf(trex);
      d.setUint32(12, t.newId);
      if (!t.trex) d.setUint32(16, 1);
      return trex;
    });
    const mvex = box('mvex', mehd, ...trexes);
    const moov = box('moov', mvhd, ...traks, mvex);
    // 나중에 길이를 적을 자리
    const moovStart = ftyp.byteLength;
    this.patches = [
      { pos: moovStart + 8 + (v1 ? 32 : 24), v1, kind: 'mvhd' },
      { pos: moovStart + 8 + mvhd.byteLength + traks.reduce((n, x) => n + x.byteLength, 0) + 8 + 12, v1: true, kind: 'mehd' },
    ];
    const init = new Uint8Array(ftyp.byteLength + moov.byteLength);
    init.set(ftyp); init.set(moov, ftyp.byteLength);
    return init;
  }

  async writeFrag(src, unit) {
    const dv = dvOf(unit);
    const moof = boxes(unit)[0];
    const mfhd = child(unit, moof, 'mfhd');
    let kept = 0;
    for (const traf of children(unit, moof, 'traf')) {
      const tfhd = child(unit, traf, 'tfhd');
      if (!tfhd) continue;
      const t = this.byKey.get(`${src.name}:${dv.getUint32(tfhd.from + 4)}`);
      if (!t) continue;
      kept++;
      const flags = dv.getUint32(tfhd.from) & 0xffffff;
      if (flags & 0x1) throw new Error('지원하지 않는 조각 형식입니다(절대 위치). 위의 녹화를 이용해 주세요.');
      dv.setUint32(tfhd.from + 4, t.newId);
      const tfdt = child(unit, traf, 'tfdt');
      let at = t.end;
      if (tfdt) {
        const v1 = unit[tfdt.from] === 1;
        const raw = v1 ? Number(dv.getBigUint64(tfdt.from + 4)) : dv.getUint32(tfdt.from + 4);
        if (t.pendingDisc) { t.shift = t.end - raw; t.pendingDisc = false; }
        at = Math.max(0, raw + t.shift);
        if (v1) dv.setBigUint64(tfdt.from + 4, BigInt(at));
        else if (at <= 0xffffffff) dv.setUint32(tfdt.from + 4, at);
        else throw new Error('영상이 너무 길어 한 파일로 합칠 수 없습니다.');
      }
      t.end = at + this.trafDuration(unit, traf, flags, t);
      this.endSec = Math.max(this.endSec, t.end / t.timescale);
    }
    if (!kept) return;
    if (mfhd) dv.setUint32(mfhd.from + 4, this.seq++);
    await this.sink.write(unit);
  }

  // 조각에 든 샘플들의 길이 합 (트랙 시간 단위)
  trafDuration(u8, traf, tfhdFlags, t) {
    const dv = dvOf(u8);
    const tfhd = child(u8, traf, 'tfhd');
    let p = tfhd.from + 8;
    if (tfhdFlags & 0x1) p += 8;
    if (tfhdFlags & 0x2) p += 4;
    const def = tfhdFlags & 0x8 ? dv.getUint32(p) : t.defaultDur;
    let total = 0;
    for (const trun of children(u8, traf, 'trun')) {
      const f = dv.getUint32(trun.from) & 0xffffff;
      const n = dv.getUint32(trun.from + 4);
      if (!(f & 0x100)) { total += n * def; continue; }
      let q = trun.from + 8 + (f & 0x1 ? 4 : 0) + (f & 0x4 ? 4 : 0);
      const step = 4 * (1 + !!(f & 0x200) + !!(f & 0x400) + !!(f & 0x800));
      for (let i = 0; i < n && q + 4 <= trun.end; i++, q += step) total += dv.getUint32(q);
    }
    return total;
  }

  async finish() {
    if (!this.ready) await this.start();
    // 다 쓴 뒤 전체 길이를 앞쪽 정보에 적는다 (플레이어가 길이를 바로 알고, 탐색 막대가 제대로 나온다)
    const dur = Math.round(this.endSec * this.timescale);
    for (const p of this.patches) {
      const b = new Uint8Array(p.v1 ? 8 : 4), d = dvOf(b);
      if (p.v1) d.setBigUint64(0, BigInt(dur)); else d.setUint32(0, Math.min(dur, 0xffffffff));
      await this.sink.patch(p.pos, b);
    }
    return { seconds: this.endSec, audioOnly: !this.kinds.has('vide'), hasAudio: this.kinds.has('soun') };
  }
}
