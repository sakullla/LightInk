# LightInk 官网落地页

纯静态双语（zh-CN / en）产品落地页：无构建链、无框架、无外部请求（无 CDN、无 Web 字体、无统计脚本），直接用 `index.html` + `assets/` 截图即可离线打开。

## 文件结构

```
website/
├── index.html    # 单文件页面：内联 CSS/JS、zh/en 双字典、四平台下载卡、FAQ、截图
├── assets/       # 1280 宽 warm-light / dark 截图（shelf / editor / reader）
└── README.md     # 本文件
```

## 本地预览

直接用浏览器打开 `website/index.html`（file:// 即可，页面不依赖任何外部资源），或起任意静态服务器，例如：

```bash
npx serve website
```

## 截图再生成

`assets/` 中的截图来自仓库的界面采集管线（`scripts/capture-ui.mjs`），选片为
`shelf` / `editor` / `reader` 三个场景 × `warm-light` / `dark` 两个主题 × 1280 宽。
UI 变更后按下面步骤重新生成并同步：

```bash
# 1) 只跑 1280 宽、两主题的默认矩阵（输出默认写入 docs/verification/ui，该目录被 gitignore）
npm run capture:ui           # 需先 npx playwright install chromium

# 2) 把选定的六张图复制进 website/assets/
cp docs/verification/ui/shelf-warm-light-1280.png   website/assets/
cp docs/verification/ui/shelf-dark-1280.png         website/assets/
cp docs/verification/ui/editor-warm-light-1280.png  website/assets/
cp docs/verification/ui/editor-dark-1280.png        website/assets/
cp docs/verification/ui/reader-warm-light-1280.png  website/assets/
cp docs/verification/ui/reader-dark-1280.png        website/assets/
```

也可用环境变量缩小矩阵（见仓库根 `AGENTS.md`）：

```bash
LIGHTINK_CAPTURE_WIDTHS=1280 npm run capture:ui
```

注意：`index.html` 引用的文件名与上表一一对应；新增/改名截图时需同步更新
`#screenshots` 区块的 `<img src>` 与 `figcaption`。

## 页面行为要点

- **双语切换**：默认跟随 `navigator.languages`（zh 前缀 → 中文，否则英文）；手动点选后写入
  `localStorage` 键 `lightink.site.locale`（站点独立键，不复用应用前端的 `lightink.locale`）。
- **平台卡片**：按 `navigator.userAgent` 高亮访客系统（Windows / macOS / Linux / Android），
  识别不出则不高亮；所有下载按钮统一指向
  `https://github.com/sakullla/LightInk/releases/latest`，避免版本化文件名随版本 404。
- **配色**：浅/深两套 CSS 变量取自应用内置主题令牌（`src/theme/tokens.css` 的
  warm-light / dark），跟随 `prefers-color-scheme`；系统字体栈覆盖 CJK，无网络字体。
- **FAQ**：macOS Gatekeeper 首启放行、NSIS 与 MSI 区别、Android APK 手动安装、
  macOS 11.0+ 系统要求（与 `src-tauri/tauri.conf.json` 的 `minimumSystemVersion` 一致）。

## 发布（GitHub Pages）

`.github/workflows/website.yml` 会在 `website/**` 变更合入 `main` 后，用标准
`upload-pages-artifact` + `deploy-pages` actions 发布本目录。

首次启用 Pages 是仓库侧一次性操作：

1. 打开仓库 **Settings → Pages**；
2. **Source** 选择 **GitHub Actions**（不是 Deploy from a branch）；
3. 保存后推送任意 `website/**` 变更即可触发部署。

站点地址形如 `https://sakullla.github.io/LightInk/`。
