// 확장 ZIP을 서명한 CRX(3판) 파일과 자동 업데이트 안내 파일(updates.xml)로 만든다.
// 회사 PC의 Edge·Chrome에 정책으로 설치하면, 브라우저가 updates.xml을 보고 새 버전으로 알아서 업데이트한다.
//
// 사용: node scripts/pack-crx.mjs <확장 ZIP> <출력 폴더> <사이트 주소>
// 서명 열쇠(RSA 개인 키, PEM)는 환경 변수 CRX_PRIVATE_KEY로 받는다. 열쇠가 바뀌면 확장 ID가 바뀌므로 같은 열쇠를 계속 써야 한다.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [zipPath, outDir, site] = process.argv.slice(2);
const pem = process.env.CRX_PRIVATE_KEY;
if (!zipPath || !outDir || !site || !pem) { console.error('사용: CRX_PRIVATE_KEY=... node scripts/pack-crx.mjs <zip> <out> <site>'); process.exit(1); }

// 프로토콜 버퍼의 "길이가 붙은 바이트" 필드 하나
const varint = n => { const out = []; while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
const field = (num, bytes) => Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes]);

const zip = readFileSync(zipPath);
const key = createPrivateKey(pem);
const pub = createPublicKey(key).export({ type: 'spki', format: 'der' });
const crxId = createHash('sha256').update(pub).digest().subarray(0, 16);
const signedData = field(1, crxId); // SignedData { crx_id }
const len = Buffer.alloc(4); len.writeUInt32LE(signedData.length);
const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'binary'), len, signedData, zip]), key);
const header = Buffer.concat([field(2, Buffer.concat([field(1, pub), field(2, signature)])), field(10000, signedData)]);
const pre = Buffer.alloc(12);
pre.write('Cr24', 0, 'binary'); pre.writeUInt32LE(3, 4); pre.writeUInt32LE(header.length, 8);
writeFileSync(join(outDir, 'tonicstream.crx'), Buffer.concat([pre, header, zip]));

// 확장 ID: crx_id의 16진수 글자 0~f를 a~p로 바꾼 것
const id = [...crxId.toString('hex')].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
writeFileSync(join(outDir, 'updates.xml'), `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${site}/tonicstream.crx' version='${version}' />
  </app>
</gupdate>
`);
writeFileSync(join(outDir, 'extension-id.txt'), id + '\n');
console.log('CRX', version, 'id', id);
