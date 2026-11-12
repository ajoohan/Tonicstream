# Edge 추가 기능 스토어 제출 자료

제출은 [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)에서 합니다. 가입과 등록은 무료입니다.

## 1. 패키지

- 업로드 파일: https://stream.plustonic.com/tonicstream-extension.zip
  - `extension/` 폴더를 압축한 파일로, 배포할 때마다 자동으로 새로 만들어집니다.
  - `manifest.json`이 압축 파일 맨 위에 있어서 그대로 올리면 됩니다.
- 버전: 0.4.0

## 2. 속성 (Properties)

| 항목 | 값 |
|---|---|
| 카테고리 | 생산성 (Productivity) |
| 개인정보 처리방침 URL | https://stream.plustonic.com/privacy.html |
| 웹사이트 URL | https://stream.plustonic.com/ |
| 지원 연락처 | 담당자 이메일 (직접 입력) |
| 성인 콘텐츠 | 아니요 |

## 3. 스토어 등록 정보 (한국어)

**이름:** Tonicstream 영상 저장

**짧은 설명:**
브라우저에서 재생 중인 쇼츠·릴스·틱톡·Vimeo 영상을 클릭 한 번에 MP4로 저장합니다.

**설명:**
```
Tonicstream은 브라우저에서 재생 중인 영상을 MP4 파일로 저장하는 확장 프로그램입니다.

■ 세 가지 저장 방법
• 영상 녹화: 페이지에서 재생 중인 영상을 그대로 녹화해 MP4로 저장합니다. 처음부터 끝까지, 또는 지금부터 녹화할 수 있습니다.
• 원본 다운로드: 페이지가 불러온 원본 영상 파일이 감지되면 바로 내려받습니다.
• 탭 녹화: 다른 방법이 안 되는 사이트에서도 탭의 화면과 소리를 그대로 녹화합니다.

■ 이렇게 사용하세요
1. 영상이 있는 페이지에서 툴바의 Tonicstream 아이콘을 누릅니다. (단축키 Alt+Shift+V)
2. 감지된 영상에서 원하는 저장 방법을 고릅니다.
3. 녹화가 끝나면 MP4 파일이 다운로드 폴더에 저장됩니다.

■ 개인정보
어떤 데이터도 수집하거나 외부로 보내지 않습니다. 모든 처리는 사용자의 브라우저 안에서만 이루어집니다.

■ 유의사항
• 본인이 권리를 가졌거나 허락받은 영상만 저장하세요.
• DRM으로 보호된 영상(넷플릭스 등 유료 스트리밍)은 지원하지 않습니다.
```

**검색어:** 영상 저장, MP4, 동영상 다운로드, 화면 녹화, 숏폼

## 4. Store listing (English, optional)

**Short description:**
Save videos playing in your browser — shorts, reels, TikTok, Vimeo — as MP4 in one click.

**Description:**
```
Tonicstream saves the video you are watching in your browser as an MP4 file.

■ Three ways to save
• Record video: records the playing video element and saves it as MP4 — from the start or from now.
• Direct download: when the page loads an original video file, download it as is.
• Tab recording: records the tab's picture and sound for sites where the other methods don't work.

■ How to use
1. On a page with a video, click the Tonicstream icon (shortcut Alt+Shift+V).
2. Pick a save method for the detected video.
3. The MP4 file is saved to your Downloads folder.

■ Privacy
No data is collected or sent anywhere. Everything runs locally in your browser.

■ Notes
• Only save videos you own or have permission to use.
• DRM-protected content is not supported.
```

## 5. 이미지 (`store/images/`)

| 파일 | 용도 | 규격 |
|---|---|---|
| `logo-300.png` | 확장 프로그램 로고 (필수) | 300×300 |
| `tile-small-440x280.png` | 작은 프로모션 타일 | 440×280 |
| `tile-large-1400x560.png` | 큰 프로모션 타일 | 1400×560 |
| `screenshot-1.png`, `screenshot-2.png` | 스크린샷 | 1280×800 |

## 6. 인증 담당자 메모 (Notes for certification)

심사자에게 권한마다 쓰는 이유를 설명하는 칸입니다. 아래 내용을 그대로 붙여넣으세요.

```
Tonicstream saves videos the user is watching as MP4. No data is collected; there is no remote code and no external server.

Permission justifications:
- host_permissions <all_urls> + content script: detect <video> elements on the page the user is viewing and record them with HTMLMediaElement.captureStream + MediaRecorder. Video sites are on many domains, so a fixed list is not possible.
- webRequest: observe response headers to detect original video files (Content-Type video/*) loaded by the page, so they can be offered for direct download. Read-only; requests are never blocked or modified.
- declarativeNetRequest: adds a Referer header only for requests made by the extension itself (tabIds -1) to the TikTok CDN, which rejects downloads without it.
- downloads: save the resulting MP4 file.
- tabCapture + offscreen: "Tab recording" feature, started only by an explicit user click in the popup; the offscreen document runs MediaRecorder and fetches files for download.
- scripting + activeTab: inject the content script into frames that loaded before installation when the user opens the popup.
- storage: keep the list of detected files per tab for the current session (chrome.storage.session).

How to test: open any page with an HTML5 <video> (e.g. a Vimeo video page), start playback, click the toolbar icon, then "처음부터 끝까지 녹화" (record from start) or "지금부터 녹화" (record from now); click "정지 후 저장" to save. DRM-protected content is intentionally not supported.
```

## 7. 제출 순서

1. Partner Center에서 Microsoft 계정으로 **Edge 개발자 등록**을 합니다. 무료이고, 개인 또는 회사로 등록할 수 있습니다.
2. **Create new extension**을 누르고 1번의 ZIP을 업로드합니다.
3. **Availability:** 공개(Public)를 고르고, 판매 지역은 전체 또는 대한민국으로 정합니다.
4. **Properties:** 2번 표의 내용을 입력합니다.
5. **Store listings:** 한국어를 추가하고 3번 내용과 5번 이미지를 넣습니다. 영어도 추가하면 4번 내용을 넣습니다.
6. **Submission options:** 6번 메모를 붙여넣습니다.
7. **Publish**를 누릅니다. 심사는 보통 최대 7영업일 걸립니다.

승인되면 스토어 주소가 나옵니다. 그 주소로 소개 페이지의 다운로드 버튼을 바꾸면 사용자가 클릭 한 번으로 설치할 수 있습니다.

## 업데이트할 때

`extension/manifest.json`의 `version`을 올리고 main에 반영합니다. 그다음 Partner Center에서 해당 확장의 **Update**를 눌러 새 ZIP을 업로드합니다.
