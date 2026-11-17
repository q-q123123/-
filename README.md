# 体重趋势 · Android 外壳（Capacitor）

把现有网页原样打进 APK 里：**没有地址栏、不依赖 Chrome、断网可用**。
网页本体仍是上一级目录的 `dist/site`，`www/` 是它的副本。

## 为什么用 Capacitor 而不是 TWA

| | TWA（之前那个 APK） | 这个 Capacitor 壳 |
|---|---|---|
| 地址栏 | 消除它必须配 assetlinks（surge 免费版做不到） | 天然没有 |
| 依赖 Chrome | 是，华为等机型可能打不开 | 否，用系统 WebView |
| 断网 | 靠 Service Worker 缓存 | 资源就在 APK 里 |
| 更新 | 重新部署网址即可 | 改完要重新打包 |

## 方式一：GitHub Actions 云构建（推荐，不用装任何工具）

1. 在 GitHub 新建一个仓库（Private 也可以），把本文件夹的内容传上去。
   - 网页上传：仓库首页 → Add file → Upload files → 把这个文件夹里的东西拖进去（`.github` 目录也要）。
   - 用命令：`git init && git add . && git commit -m init && git remote add origin <仓库地址> && git push -u origin main`
2. 生成签名密钥的 base64（在 PowerShell 里跑，路径换成你自己的 keystore）：

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\路径\signing.keystore')) | Set-Clipboard
   ```

   内容已经在剪贴板里了。
3. 仓库 → Settings → Secrets and variables → Actions → New repository secret，加四个：

   | Name | Value |
   |---|---|
   | `KEYSTORE_BASE64` | 上一步复制的整段 base64 |
   | `KEY_ALIAS` | `my-key-alias`（见 signing-key-info.txt） |
   | `KEYSTORE_PASSWORD` | keystore 密码 |
   | `KEY_PASSWORD` | key 密码 |

4. 仓库 → Actions → 左侧 `build-apk` → Run workflow。约 4–6 分钟。
5. 跑完点进这次运行，底部 Artifacts 下载 `app-signed`，解压得到 `app-signed.apk`。
6. 传到手机安装（允许「未知来源」）。

> 没配 secrets 也能跑，但产出的是调试签名版，以后无法覆盖安装，建议配齐。

## 方式二：本机构建（要装 Android Studio）

1. 装 Android Studio（会一并装好 JDK 17 和 Android SDK）。
2. 在本文件夹里运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\build-local.ps1
   ```

3. 产物在 `android\app\build\outputs\apk\debug\app-debug.apk`。

## 装好之后

- 这是**另一个 App**（包名 `com.wttrend.app`），和浏览器、和之前的 TWA 都不是同一份存储。
- 第一次打开是空的，需要：网页版「设置 → 导出 JSON」→ App 里「设置 → 导入数据」。

## 以后更新

1. 我把新版网页放到 `dist/site`，重新生成一次 `www/`（`Copy-Item ..\dist\site\* www -Recurse -Force`）。
2. 提交推送 → Actions 自动构建 → 下载新 APK → 覆盖安装。
3. 签名一致，所以是升级，**数据保留**。

## 改名 / 换图标 / 换包名

- 名字：改 `capacitor.config.json` 的 `appName`，重新打包。
- 包名：改 `appId`。**改了就是另一个 App**，数据不通用，不要随便改。
- 图标：替换 `android/app/src/main/res/mipmap-*/ic_launcher.png` 后重新打包（首次 `npx cap add android` 之后才有这个目录）。
