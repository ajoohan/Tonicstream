// 저장 파일 이름·폴더 규칙. 배경(background), 팝업, 화면 녹화 창이 함께 쓴다.
// 설정은 이 브라우저에만 저장된다(chrome.storage.local).
const NAMING_DEFAULTS = { folder: '', pattern: 'title' }; // pattern: title | date_title | date_site_title

const safeName = s => (s || 'video').replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'video';

// "Tonicstream/레퍼런스" 같은 하위 폴더 경로. 다운로드 폴더 밖으로는 나갈 수 없다.
const safeFolder = s => (s || '').split(/[\\/]+/).map(p => p.replace(/[:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60)).filter(Boolean).slice(0, 4).join('/');

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
