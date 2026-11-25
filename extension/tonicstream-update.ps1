# Tonicstream 업데이트 도우미
# 이 파일이 들어 있는 폴더(= 확장 폴더)를 최신 버전으로 바꿉니다. 같은 폴더의 Tonicstream-update.cmd를 더블클릭하면 실행됩니다.
# 하는 일: 새 버전 확인 → 내려받기 → 이 폴더의 파일 교체. 그 밖에는 아무것도 바꾸지 않습니다.
$ErrorActionPreference = 'Stop'
$Site = if ($env:TONIC_SITE) { $env:TONIC_SITE } else { 'https://stream.plustonic.com' }
$Ext = $PSScriptRoot
$tmp = $null
function Done($msg, $color = 'Green') {
  Write-Host ''
  Write-Host $msg -ForegroundColor $color
  if (-not $env:TONIC_NOPAUSE) { Read-Host '창을 닫으려면 Enter' | Out-Null }
}
try {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  $Host.UI.RawUI.WindowTitle = 'Tonicstream 업데이트'
  Write-Host '== Tonicstream 업데이트 ==' -ForegroundColor Cyan
  $manifest = Join-Path $Ext 'manifest.json'
  $m = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($m.name -notmatch 'Tonicstream') { throw "확장 폴더가 아닙니다: $Ext" }
  $local = $m.version
  Write-Host "설치된 버전: $local"
  Write-Host '새 버전을 확인하는 중…'
  $remote = (Invoke-RestMethod -Uri "$Site/version.json?t=$([DateTime]::UtcNow.Ticks)" -UseBasicParsing).version
  if ([version]$remote -le [version]$local -and -not $env:TONIC_FORCE) {
    Done "이미 최신 버전($local)입니다."
    return
  }
  Write-Host "새 버전 $remote 을(를) 내려받는 중…"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('tonicstream-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'ext.zip'
  $ProgressPreference = 'SilentlyContinue' # 진행 표시를 그리면 내려받기가 아주 느려진다 (PowerShell 5.1)
  Invoke-WebRequest -Uri "$Site/tonicstream-extension.zip?t=$([DateTime]::UtcNow.Ticks)" -OutFile $zip -UseBasicParsing
  $new = Join-Path $tmp 'new'
  Expand-Archive -LiteralPath $zip -DestinationPath $new -Force
  if (-not (Test-Path (Join-Path $new 'manifest.json'))) { throw '내려받은 파일이 올바르지 않습니다.' }

  Write-Host '파일을 바꾸는 중…'
  $keep = @{}
  # manifest.json(버전 정보)은 맨 마지막에 바꾼다. 확장이 새 버전을 알아챌 때 다른 파일은 이미 모두 바뀌어 있도록.
  foreach ($f in (Get-ChildItem -LiteralPath $new -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($new.Length).TrimStart('\', '/')
    $keep[$rel.ToLower().Replace('\', '/')] = $true
    if ($rel -eq 'manifest.json') { continue }
    $dest = Join-Path $Ext $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
  }
  # 새 버전에 없는 옛 파일은 지운다
  foreach ($f in (Get-ChildItem -LiteralPath $Ext -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($Ext.TrimEnd('\', '/').Length).TrimStart('\', '/').ToLower().Replace('\', '/')
    if (-not $keep.ContainsKey($rel)) { Remove-Item -LiteralPath $f.FullName -Force }
  }
  Copy-Item -LiteralPath (Join-Path $new 'manifest.json') -Destination $manifest -Force

  # 다음부터 찾기 쉽게 바탕화면에 바로가기를 만들어 둘지 묻는다 (처음 한 번)
  try {
    $desk = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desk 'Tonicstream 업데이트.lnk'
    if ($desk -and -not (Test-Path $lnk) -and -not $env:TONIC_NOPAUSE) {
      $ans = Read-Host '바탕화면에 "Tonicstream 업데이트" 바로가기를 만들까요? (Y/N)'
      if ($ans -match '^[Yy예]') {
        $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
        $sc.TargetPath = Join-Path $Ext 'Tonicstream-update.cmd'
        $sc.WorkingDirectory = $Ext
        $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,238"
        $sc.Save()
        Write-Host '바로가기를 만들었습니다. 다음부터는 바탕화면에서 더블클릭하세요.'
      }
    }
  } catch {}

  Done "$remote 버전으로 바꿨습니다. Edge에서 Tonicstream 아이콘을 눌러 맨 위의 [지금 적용]을 누르세요. (또는 Edge를 껐다 켜기)"
} catch {
  Done "업데이트하지 못했습니다: $($_.Exception.Message)" 'Red'
} finally {
  if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
