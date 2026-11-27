# Edge 추가 기능 스토어 제출 자료 (숨김 등록)

회사 직원만 쓰도록 **숨김(Hidden)** 으로 등록합니다. 스토어 검색에는 나오지 않고, 회사에서 공유한 링크로만 설치할 수 있습니다. 설치한 PC는 Edge가 알아서 업데이트합니다.

제출은 [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)에서 합니다. 등록과 게시는 무료입니다.

## 1. 패키지

- 업로드 파일: https://stream.plustonic.com/tonicstream-store.zip
  - 스토어 제출 전용입니다. 자체 업데이트 주소(`update_url`)와 Windows 업데이트 도우미를 뺐습니다. (ZIP 직접 설치용 `tonicstream-extension.zip`을 올리면 거절됩니다.)
  - 배포할 때마다 자동으로 새로 만들어집니다. `manifest.json`이 압축 파일 맨 위에 있어 그대로 올리면 됩니다.
- 버전: 0.14.2

## 2. 제출 순서

1. Partner Center에 Microsoft 계정으로 로그인 → **Microsoft Edge** → **Create new extension**
2. **Packages**: 1번의 `tonicstream-store.zip`을 받아 업로드합니다.
3. **Availability**
   - Visibility: **Hidden** ← 꼭 숨김으로
   - Markets: 대한민국 (해외 직원이 있으면 전체)
4. **Properties**: 3번 표를 입력합니다.
5. **Store listings**: 언어 **한국어**를 추가하고 4번 글과 7번 이미지를 넣습니다. (영어는 선택: 5번)
6. **Submission options** → Notes for certification: 6번 글을 그대로 붙여 넣습니다.
7. **Publish**. 심사는 보통 수 영업일, 길면 7영업일 걸립니다.

승인되면 확장 페이지 주소(`https://microsoftedge.microsoft.com/addons/detail/…`)가 나옵니다. 이 주소를 알려 주시면 소개 페이지의 설치 버튼과 직원 공지문을 이 링크로 바꿉니다.

### 승인 뒤 직원 전환
- 직원은 링크를 열고 **[받기]** 한 번으로 설치합니다. 개발자 모드·압축 풀기가 필요 없습니다.
- 스토어 설치본은 ZIP 설치본과 별개 확장입니다. 예전 확장의 **보관함 → 백업**, 새 확장의 **보관함 → 가져오기** 후 예전 것을 제거합니다.

### 새 버전을 낼 때
`extension/manifest.json`의 `version`을 올려 main에 반영하면 `tonicstream-store.zip`이 새로 만들어집니다. Partner Center에서 해당 확장 → **Update** → 새 ZIP 업로드 → **Publish**. 심사를 거쳐 반영되면 직원 PC는 Edge가 자동으로 업데이트합니다.

## 3. 속성 (Properties)

| 항목 | 값 |
|---|---|
| 카테고리 | 생산성 (Productivity) |
| 개인정보 처리방침 URL | https://stream.plustonic.com/privacy.html |
| 웹사이트 URL | https://stream.plustonic.com/ |
| 지원 연락처 | 담당자 이메일 (직접 입력) |
| 성인 콘텐츠 | 아니요 |

## 4. 스토어 등록 정보 (한국어)

**이름:** Tonicstream 영상 저장

**짧은 설명:**
브라우저에서 재생 중인 영상을 MP4로 저장하고, 장면 캡처·콘티 시트·레퍼런스 보관함으로 정리합니다.

**설명:**
```
Tonicstream은 브라우저에서 보고 있는 영상을 MP4 파일로 저장하고, 레퍼런스로 정리하는 확장 프로그램입니다.

■ 저장 방법
• 영상 녹화: 페이지에서 재생 중인 영상을 그대로 녹화합니다. 처음부터 끝까지, 지금부터, 또는 원하는 구간만 저장할 수 있습니다.
• 원본 다운로드: 페이지가 불러온 원본 영상 파일이 있으면 바로 내려받습니다.
• 스트리밍 영상 받기: 조각으로 나뉘어 재생되는 영상(HLS·DASH)을 받아 MP4 한 파일로 합칩니다. 화질을 고를 수 있습니다.
• 탭 녹화: 다른 방법이 안 되는 사이트에서도 탭의 화면과 소리를 그대로 녹화합니다.
• 화면 녹화: 모니터 전체나 다른 프로그램 창을 녹화합니다. 컴퓨터 소리와 마이크를 함께 담을 수 있습니다.

■ 캡처와 정리
• 장면 캡처: 지금 보이는 장면을 PNG로 저장합니다.
• 장면 콘티 시트: 영상 전체에서 장면 12개를 뽑아 한 장짜리 이미지로 만듭니다.
• 페이지 전체 캡처: 상세페이지·랜딩페이지를 위에서 아래까지 한 장으로 저장합니다.
• 레퍼런스 보관함: 저장한 영상을 보드·별점·메모·태그로 정리하고, 계정·게시일·해시태그 같은 공개 게시물 정보를 함께 기록합니다. HTML·CSV로 내보내 팀에 공유할 수 있고, 백업 파일로 옮길 수 있습니다. 기록은 내 브라우저에만 저장됩니다.
• 우클릭 메뉴: 영상 위에서 마우스 오른쪽 버튼으로 바로 저장·녹화·캡처합니다.

■ 이렇게 사용하세요
1. 영상이 있는 페이지에서 툴바의 Tonicstream 아이콘을 누릅니다. (단축키 Alt+Shift+V)
2. 원하는 저장 방법을 고릅니다.
3. 파일은 다운로드 폴더에 저장됩니다.

■ 개인정보
어떤 데이터도 수집하거나 외부로 보내지 않습니다. 모든 처리는 사용자의 브라우저 안에서 이루어집니다.

■ 유의사항
• 본인이 권리를 가졌거나 허락받은 영상만 저장하세요.
• DRM으로 보호된 영상(넷플릭스 등 유료 스트리밍)은 지원하지 않습니다.
```

**검색어:** 영상 저장, MP4, 화면 녹화, 레퍼런스, 콘티

## 5. Store listing (English, optional)

**Short description:**
Save videos playing in your browser as MP4, and organise them with frame capture, contact sheets and a reference library.

**Description:**
```
Tonicstream saves the video you are watching in your browser as an MP4 file and helps you keep it as a reference.

■ Ways to save
• Record video: records the playing video element — from the start, from now, or a chosen range.
• Direct download: when the page loads an original video file, download it as is.
• Streaming download: fetches segmented streams (HLS, DASH) and joins them into one MP4, with a quality choice.
• Tab recording: records the tab's picture and sound where other methods don't work.
• Screen recording: records the entire screen or another app window, with system and microphone audio.

■ Capture and organise
• Frame capture (PNG), 12-frame contact sheet, full-page capture.
• Reference library: boards, star ratings, notes and tags, plus public post info (account, date, hashtags). Export as HTML or CSV, back up to a file. Stored only in your browser.
• Right-click menu on any video to save, record or capture.

■ Privacy
No data is collected or sent anywhere. Everything runs locally in your browser.

■ Notes
• Only save videos you own or have permission to use.
• DRM-protected content is not supported.
```

## 6. 인증 담당자 메모 (Notes for certification)

```
Tonicstream is an internal tool for our marketing team (listed as Hidden). It saves videos the user is watching as MP4 and keeps a local reference library. No data is collected; there is no remote code and no external server of ours that receives user data.

Permission justifications:
- host_permissions <all_urls> + content script: detect <video> elements on the page the user is viewing and record them with HTMLMediaElement.captureStream + MediaRecorder. Video sites are on many domains, so a fixed list is not possible.
- webRequest: read response headers to detect original video files (video/*) and streaming playlists (HLS .m3u8 / DASH .mpd) loaded by the page. Read-only; nothing is blocked or modified.
- declarativeNetRequest: session rules that set Referer/Origin only on requests made by the extension itself (tabIds -1, initiator = this extension) — for the TikTok CDN and, while the user downloads a stream, the page the stream came from — because those servers reject requests without them. Page requests are never modified.
- offscreen: an offscreen document runs MediaRecorder for tab recording, fetches files for download, and joins streaming segments (HLS/DASH) into one MP4 (bundled mux.js, Apache-2.0, in vendor/).
- unlimitedStorage: large streaming downloads are written to the extension's origin-private file system while segments are joined, then saved with the downloads API and deleted.
- downloads: save the resulting files.
- tabCapture: "Tab recording", started only by an explicit click in the popup.
- contextMenus: a "Tonicstream" right-click menu (save / record / frame capture / contact sheet / full-page capture / open library). Runs only when the user picks an item.
- scripting + activeTab: inject the content script into tabs that were open before installation, when the user opens the popup or uses the context menu.
- storage: save settings and the reference library (local), and per-tab detection state (session). The library may include public post info read from the saved page (author, date, caption, hashtags, view/like counts). Nothing leaves the browser.
- Screen recording (no extra permission): getDisplayMedia in the extension's own recorder window; the user picks the screen in the browser's picker. Microphone/camera only when the user turns them on; the camera is shown in a Picture-in-Picture window and not stored.
- Frame capture / contact sheet / full-page capture: draw <video> frames to a canvas; for cross-origin videos, and for full-page capture, chrome.tabs.captureVisibleTab is used only while the user-started capture runs.
- Update notice code in the popup only runs for unpacked installs (installType "development"); store installs skip it.

How to test:
1. Open a page with an HTML5 video (e.g. a Vimeo video page) and start playback.
2. Click the toolbar icon → "처음부터 끝까지 녹화" (record from start); click "정지 후 저장" (stop and save) on the page.
3. Same popup: "장면 캡처" (frame capture) and "콘티 시트" (contact sheet) save PNGs.
4. Right-click on the video → Tonicstream → any item.
5. "보관함" (library) button opens the reference library page.
DRM-protected content is intentionally not supported.
```

## 7. 이미지 (`store/images/`)

| 파일 | 용도 | 규격 |
|---|---|---|
| `logo-300.png` | 확장 프로그램 로고 (필수) | 300×300 |
| `tile-small-440x280.png` | 작은 프로모션 타일 | 440×280 |
| `tile-large-1400x560.png` | 큰 프로모션 타일 | 1400×560 |
| `screenshot-1.png`, `screenshot-2.png` | 스크린샷 | 1280×800 |
