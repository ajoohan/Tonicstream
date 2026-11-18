// 저장 파일 이름·폴더 규칙. 배경(background), 팝업, 화면 녹화 창이 함께 쓴다.
// 설정은 이 브라우저에만 저장된다(chrome.storage.local).
// quality: high | medium | small (녹화 화질)   board: 새로 저장할 때 넣을 보관함 보드 이름
// hover: ads | all | off (영상 위에 저장 버튼을 띄울 곳. ads = 광고 라이브러리 사이트만)
const NAMING_DEFAULTS = { folder: '', pattern: 'title', library: true, quality: 'high', board: '', hover: 'ads' };

// 녹화 화질: 초당 비트 수와(탭·화면 녹화의) 최대 크기
const QUALITY = {
  high: { bits: 8_000_000, w: 1920, h: 1080 },
  medium: { bits: 4_000_000, w: 1920, h: 1080 },
  small: { bits: 1_500_000, w: 1280, h: 720 },
};
const qualityOf = naming => QUALITY[naming?.quality] || QUALITY.high; // pattern: title | date_title | date_site_title

// 파일·폴더 이름에 쓸 수 없는 글자를 걸러낸다.
// - \ / : * ? " < > | ~ 와 제어 문자
// - 눈에 보이지 않는 서식 문자(결합 이모지를 잇는 글자, 폭 없는 공백, 방향 표시 등): 브라우저가 "Invalid filename"으로 거절한다
// - CON, NUL 같은 Windows 예약 이름
const NAME_BAD = /[\\/:*?"<>|~\p{Cc}\p{Cf}]+/gu;
const NAME_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
function cleanPart(s, max) {
  let t = String(s || '').replace(NAME_BAD, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  t = [...t].slice(0, max).join('').replace(/[.\s]+$/g, ''); // 글자 단위로 잘라 이모지가 반쪽 나지 않게
  return NAME_RESERVED.test(t) ? `_${t}` : t;
}
const safeName = s => cleanPart(s, 80) || 'video';

// "Tonicstream/레퍼런스" 같은 하위 폴더 경로. 다운로드 폴더 밖으로는 나갈 수 없다.
const safeFolder = s => String(s || '').split(/[\\/]+/).map(p => cleanPart(p, 60)).filter(Boolean).slice(0, 4).join('/');

const siteOf = url => { try { return new URL(url).hostname.replace(/^(www|m)\./, ''); } catch { return ''; } };

const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function getNaming() {
  const { naming } = await chrome.storage.local.get('naming');
  return { ...NAMING_DEFAULTS, ...naming };
}

// 설정을 적용한 저장 경로를 만든다. ext가 없으면 확장자 없이 돌려준다.
// plain: 이름 규칙은 건너뛰고 폴더만 적용 (화면 녹화처럼 이름에 이미 날짜가 있는 경우)
function formatName(naming, title, pageUrl, ext, { plain = false, suffix = '' } = {}) {
  const site = siteOf(pageUrl);
  const parts = [];
  if (!plain && naming.pattern !== 'title') parts.push(today());
  if (!plain && naming.pattern === 'date_site_title' && site) parts.push(site);
  parts.push(safeName(title));
  const name = safeName(parts.join('_')) + (suffix ? ` ${suffix}` : '');
  const folder = safeFolder(naming.folder);
  return (folder ? `${folder}/` : '') + name + (ext ? `.${ext}` : '');
}

async function buildName(title, pageUrl, ext, opts) {
  return formatName(await getNaming(), title, pageUrl, ext, opts);
}

// 저장을 시작한다. 이름이 거절되면(예상 못 한 글자 등) 녹화본을 잃지 않도록 안전한 기본 이름으로 한 번 더 시도한다.
async function safeDownload(url, filename) {
  try {
    return await chrome.downloads.download({ url, filename, saveAs: false });
  } catch (e) {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const ext = (filename.match(/\.([a-z0-9]{2,4})$/i) || [, 'mp4'])[1];
    const fallback = `Tonicstream ${today(d)} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
    console.warn('저장 이름이 거절되어 기본 이름으로 저장합니다:', filename, e);
    return chrome.downloads.download({ url, filename: fallback, saveAs: false });
  }
}
