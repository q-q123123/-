<#
  本机构建 APK（需要 JDK 17 + Android SDK，装 Android Studio 最省事）
  用法：powershell -ExecutionPolicy Bypass -File .\build-local.ps1
#>
param([switch]$Release)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  Write-Host '没找到 java。请先安装 JDK 17（或直接装 Android Studio）。' -ForegroundColor Red
  Read-Host '按回车关闭'; exit 1
}

if (-not (Test-Path 'node_modules')) {
  Write-Host '安装依赖 ...' -ForegroundColor Cyan
  npm install
}

if (-not (Test-Path 'android')) {
  Write-Host '生成 Android 工程 ...' -ForegroundColor Cyan
  npx cap add android
}

Write-Host '同步网页资源 ...' -ForegroundColor Cyan
npx cap sync android

Push-Location android
if ($Release) { .\gradlew.bat assembleRelease } else { .\gradlew.bat assembleDebug }
Pop-Location

$out = if ($Release) { 'android\app\build\outputs\apk\release\app-release-unsigned.apk' } else { 'android\app\build\outputs\apk\debug\app-debug.apk' }
Write-Host ''
if (Test-Path $out) { Write-Host ('APK: ' + (Resolve-Path $out)) -ForegroundColor Green } else { Write-Host '没找到产物，请检查上面的报错。' -ForegroundColor Red }
Read-Host '按回车关闭'
