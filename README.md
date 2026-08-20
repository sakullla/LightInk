# 轻墨 LightInk

一款轻量的本地电子书阅读器与 Markdown 编辑器 —— 冷启动进入书架封面墙，也可进入 Typora 式单栏所见即所得编辑；集成 OPDS 书库和按需漫画/小说阅读，基于 Tauri v2 + Milkdown 构建。

## 特性

- **所见即所得**：单栏渲染态编辑，光标进入元素才显示源码
- **完整语法**：标题 / 列表 / 任务列表 / 引用 / 代码块（highlight.js 全量语言高亮）/ 表格 / 链接 / 图片 / 粗斜体 / 删除线 / 分隔线
- **公式与图形**：行内与块级 LaTeX（KaTeX）、mermaid 流程图/时序图，语法错误隔离显示源码
- **图片管理**：编辑器内直接显示本地图片，可调整显示宽度与左/居中/右对齐；剪贴板粘贴与拖入图片自动落盘到 `assets/`，相对路径引用可随文档迁移
- **文件管理**：新建 / 打开 / 保存 / 另存为 / 多标签页 / 未保存关闭提示 / 崩溃恢复 / 外部变更检测与冲突提示 / 可选自动保存（默认关）
- **导出**：独立 HTML（内嵌样式与图片）、PDF（打印管线），中文无乱码
- **统一书库**：冷启动进入「我的书」封面墙；点「编辑」进入 Markdown 编辑器，编辑器内「阅读/书架」回到封面墙。集中管理本地书籍与 OPDS 1.x/2.0 作品，支持自定义嵌套分组、规则智能分组、目录、搜索、分页、封面以及 Basic/Bearer 鉴权
- **受管内容与 WebDAV**：本地书籍可复制为按 SHA-256 去重的受管副本；Markdown 可加入同步空间并保留原文件。通过一个 WebDAV 目标同步书籍元数据、分组、阅读数据、受管文档、草稿和白名单偏好，正文默认按需下载
- **按需远程阅读**：远程 EPUB、CBZ 与 PDF 使用 HTTP Range 和有界磁盘缓存读取；服务器不支持 Range 时先写入磁盘缓存，不把整本书保留在 WebView 内存中
- **漫画归档**：支持 CBZ、CBR、CB7、RAR4/5 和 7z，识别 `ComicInfo.xml`，支持自然排序、左右翻页、单双页、竖向滚动与适合宽度
- **嵌套与固实归档**：归档可递归打开至 3 层；固实 RAR/7z 顺序解码到目标条目并显示前置数据读取进度，不会无界展开整个目录
- **主题**：默认暖色护眼浅色、深色一键切换（Ctrl+J）、自定义主题 CSS 热替换
- **大纲侧栏**：按标题层级实时生成、点击跳转、可折叠
- **轻量**：Windows 安装包约 4–5 MB（NSIS/MSI），冷启动 < 1s，KaTeX/mermaid 按需加载

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri v2（Rust + WebView2） |
| 前端 | Vite + TypeScript（严格模式，无框架） |
| 编辑器 | Milkdown v7（ProseMirror）+ commonmark/gfm 预设 |
| 高亮 | highlight.js（全量语言注册） |
| 公式 | KaTeX（懒加载 chunk） |
| 图形 | mermaid（懒加载 chunk，securityLevel: strict） |
| 阅读 | PDF.js、zip.js、rars、sevenz-rust2 |
| 书库与网络 | SQLite、reqwest（rustls）、系统钥匙串 |
| 测试 | Vitest（前端）+ cargo test（Rust） |

## 书库与按需阅读

应用冷启动进入阅读器书架（「我的书」封面墙）。书架上的「编辑」进入 Markdown 编辑器（菜单栏与多标签仍可用）；编辑器里的「阅读/书架」回到封面墙。往返只走这两处带文字的入口，不再用「文件 → 书库」把书架切去编辑器。可导入本地书籍，或添加 OPDS 1.x Atom/XML 与 OPDS 2.0 JSON 目录。客户端按响应的最终 URL 解析相对链接，并限制响应大小、条目数、嵌套深度和非法 URI。OPDS 源默认要求 HTTPS；HTTP/LAN 源必须在添加时明确勾选允许。鉴权支持 Basic 和 Bearer，不支持 OAuth、Cookie 登录或 Digest。

书库索引位于 Tauri `app_data_dir` 下的 `library.sqlite3`。远程正文位于 `app_cache_dir/remote-cache`，默认使用 2 GiB LRU 上限；书库中会显示当前用量，可调整上限或清空缓存。OPDS 源可在源列表中编辑或删除。SQLite 只保存作品、源、获取链接、缓存区间和不透明凭据引用，不保存密码或 Bearer token。凭据优先进入系统钥匙串；钥匙串不可用时只在当前应用会话内保留。

支持 Range 的远程 ZIP/CBZ、EPUB、PDF 和 7z 会按元数据、章节或页面请求所需区间。无 Range 的资源会先完整写入有界磁盘缓存。已缓存区间和阅读进度可跨重启复用，但新建远程会话仍需连接源站校验资源版本；完全离线时只能继续当前会话中已命中的内容，目录浏览、搜索和未缓存区间均不可用。

固实归档没有真正的任意条目随机访问。LightInk 会从对应固实块起点按顺序解码，到目标图片后停止，并缓存已解码页面；跳到后页时可能需要下载和解码前置数据。当前远程 RAR 受 `rars` 路径读取接口限制，需要先完成磁盘缓存；远程 7z 可通过 Range 渐进读取。完整能力矩阵、安全限制和缓存语义见 [OPDS 与流式归档阅读要求](docs/requirements/opds-streaming-archives.md)。

## WebDAV 同步、受管内容与分组

在「文件 → WebDAV 同步…」中配置一个活动同步目标。默认只接受 HTTPS；局域网 HTTP 需要显式勾选。支持 Basic（可填 Nextcloud 应用密码）和 Bearer，凭据只进入系统钥匙串或当前会话，配置文件和远端快照不会保存密码、令牌或本机绝对路径。同步目标的远端布局固定为 `LightInk/v1/profile.json`、`devices/<device-id>.json` 和 `blobs/sha256/<前两位>/<sha256>`。

导入本地书籍会流式计算 SHA-256，并把正文原子复制到应用数据目录；原始文件不移动、不改写，同内容只保留一个正文对象。启用同步后，面板中的「预览迁移」会把旧书标为可复制、重复、缺失或超限，确认后才批量托管；失败项继续作为外部书籍。受管书籍跨设备先同步元数据和封面，正文在打开时下载；在书籍或自定义组菜单中选择「保留离线」后，下一次同步会下载并校验正文。

书架支持自定义多对多成员关系和最多 8 层嵌套。父组展示所有后代成员并去重；删除父组只移除直接关系并提升子组，不会删除书籍本体。智能组是只读规则视图，会根据阅读状态、书籍类型、来源、格式以及满足数量条件的作者/系列实时重建。

Markdown 通过「加入同步空间」复制为受管文档，实际引用的安全相对 `assets/` 资源一并托管，原文档保持不变。保存会留下版本，未命名草稿和正文冲突也保留为独立版本。同步白名单包括阅读进度、标注、最近受管文档、主题 CSS、OPDS 非凭据配置和阅读偏好；运行中的标签、远程缓存、外部绝对路径、未托管文档和崩溃快照不上传。后台不会替换当前有未保存修改的文档。

数据库从 v4 按 v5（受管内容）、v6（分组）、v7（同步记录）、v8（受管文档）逐版迁移；迁移在事务中执行并可重复运行。详细字段边界、冲突处理和恢复建议见 [WebDAV、书架分组与 OPDS 2.0 要求](docs/requirements/webdav-sync-groups-opds2.md)。

## 开发

```bash
npm ci               # 按 package-lock.json 安装精确依赖
npm run tauri:dev    # 启动开发模式（Vite dev server + 热重载）
```

> **Windows + Git Bash 用户**：npm 默认用 cmd.exe 转发脚本参数，会把 shell 路径拼进
> `npm test -- <path>` 之类的过滤参数。如遇此问题，在用户级 npmrc 固定 bash：
> `npm config set script-shell "C:\Program Files\Git\bin\bash.exe" --location=user`
> （此配置不能提交到仓库 `.npmrc`，否则 macOS/Linux 环境会因找不到该 Windows 路径而构建失败）。

常用命令：

```bash
npm run dev          # 仅前端 dev server（:1420）
npm run build        # tsc 严格检查 + vite 构建
npm test             # 前端全部测试（Vitest）
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 测试
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Pull Request 会由 `.github/workflows/ci.yml` 在 Ubuntu 上重复执行前端测试/构建、
Rust 格式检查、测试和 clippy。Linux CI 会安装 Tauri 所需的 WebKitGTK 系统依赖；
本机缺少这些库时，应明确报告未运行的 Rust 检查，以 CI 结果为准。

## 构建与发布

### Windows（本机已验证）

```bash
npm run tauri:build
```

产物：

- `src-tauri/target/release/lightink.exe` — 免安装可执行文件
- `src-tauri/target/release/bundle/nsis/LightInk_<version>_x64-setup.exe` — NSIS 安装包（约 4.3 MB）
- `src-tauri/target/release/bundle/msi/LightInk_<version>_x64_en-US.msi` — MSI 安装包（约 5.1 MB）

### macOS / Linux

`src-tauri/tauri.conf.json` 已包含 `bundle.macOS`（minimumSystemVersion 10.15）与 `bundle.linux`（deb/appimage 依赖声明）配置，`bundle.targets` 为 `all`。推送 tag 后 GitHub Actions 会在三平台并行构建；本地手动构建需在对应平台执行 `npm run tauri:build`（Rust 不支持交叉编译 GUI 应用）。

macOS 包使用 Tauri 的显式 ad-hoc 签名（`bundle.macOS.signingIdentity: "-"`），无需 Apple 证书。CI 会用 `codesign` 校验整个 `.app` 的签名完整性，避免只依赖 Apple Silicon 链接器为单个可执行文件生成的临时签名。

ad-hoc 签名不等于 Apple 公证。从浏览器下载后，Gatekeeper 仍可能要求用户在 Finder 中右键 `LightInk.app` 选择“打开”，或前往“系统设置 → 隐私与安全性”选择“仍要打开”。只有 `Developer ID Application` 证书加 Apple 公证才能消除这一步；详见 [Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)。

### 发布流程

推送 `v*` tag 即触发 GitHub Actions 自动编译并发布三平台安装包（见 `.github/workflows/release.yml`），Release 说明从上个 tag 以来的提交记录自动提取（按 feat/fix/其他分组，基于 conventional commits）：

```bash
# 1. 同步 package.json、package-lock.json、src-tauri/Cargo.toml、
#    src-tauri/Cargo.lock 与 src-tauri/tauri.conf.json 中的 LightInk 版本号
# 2. 全量验证（先执行 npm ci）
npm test && npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
# 3. 打 tag 并推送 —— CI 自动构建 Windows(NSIS/MSI) + macOS(DMG, Apple Silicon) + Linux(deb/AppImage)，产出草稿 Release
git tag v0.1.0 && git push origin main v0.1.0
# 4. 全部平台成功且资产校验完整后，CI 自动公开同一个 Release；失败时保持草稿
```

也可手动发布：本机 `npm run tauri:build` 后在 GitHub Releases 页面上传 `src-tauri/target/release/bundle/` 下的安装包。

## 项目结构

```
src/                  前端
  editor/             Milkdown 编辑器内核与插件（高亮/公式/图形/图片）
  tabs/               多标签页状态管理
  file/               文件读写与对话框流程
  asset/              图片资源服务
  outline/            大纲侧栏
  theme/              主题系统（令牌 + 服务）
  ui/                 极简外壳与快捷键
  export/             HTML/PDF 导出管线
  library/            本地/OPDS 统一书库视图与客户端
  sync/               WebDAV 配置、同步记录、文档版本与应用状态协调器
  reader/             电子书、漫画、随机读取源与归档适配器
src-tauri/            Rust 后端
  src/file.rs         原子写文件
  src/snapshot.rs     崩溃恢复快照
  src/asset.rs        图片落盘与迁移
  src/export.rs       导出图片读取
  src/library.rs      SQLite 书库与有界区间缓存
  src/remote.rs       安全 HTTP Range 与凭据存储
  src/opds.rs         OPDS 1.x Atom/XML 与 OPDS 2.0 JSON 解析
  src/archive.rs      ZIP/RAR/7z 原生归档会话
docs/requirements/   功能范围、约束与验收说明
```

## 已知限制

- macOS/Linux 安装包由 GitHub Actions 在对应平台编译；macOS 包采用 ad-hoc 签名，未经过 Apple 公证，首次启动可能需要用户手动允许
- 崩溃恢复经单元测试验证逻辑（过期检测/索引/恢复流程），未做真实进程强杀的端到端验证
- OPDS 2.0 覆盖目录、导航、出版物、搜索模板和分页；服务端特有扩展仍可能被忽略，不支持 OAuth、Cookie 登录和 Digest
- WebDAV 当前每个配置只保留一个活动目标，正文与元数据不做客户端加密；新设备必须重新输入凭据，远端无引用 blob 的清理需要满足保留期后才会执行
- 组成员、标注和正文版本会记录冲突；后台同步不会强行替换打开且有未保存修改的文档，需在冲突面板中处理
- 固实归档访问后页可能需要读取并解码前置压缩数据；远程 RAR 当前需要先完成有界磁盘缓存
- 压缩 codec 的实际支持范围由纯 Rust `rars` 与 `sevenz-rust2` 决定，不会回退调用系统 WinRAR 或 7-Zip

## License

[GPL-3.0](LICENSE)
