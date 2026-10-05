/**
 * 捕获 LightInk 的 UI/UX 截图（合成 IPC 数据，仅用于视觉审阅与人工对比，
 * 不作为平台验收证据）。
 *
 * 用法：
 *   node scripts/capture-ui.mjs
 *   LIGHTINK_CAPTURE_WIDTHS=1440,1024 node scripts/capture-ui.mjs
 *   LIGHTINK_CAPTURE_THEMES=warm-light,midnight node scripts/capture-ui.mjs
 *   LIGHTINK_CAPTURE_AI=1 node scripts/capture-ui.mjs
 * AI 模式使用内存配置、模拟流式回复与翻译，不读取密钥、不访问 AI 服务。
 *
 * 书架与阅读器纸张主题独立于编辑器主题：深色编辑器主题（dark / midnight /
 * *-dark）默认截取 ink 书架与 night 纸张，浅色默认 gallery / sepia。可用
 * LIGHTINK_CAPTURE_LIBRARY_THEME 与 LIGHTINK_CAPTURE_READER_THEME 覆盖。
 *
 * 未检测到 dev server 时脚本会自行启动 `npm run dev`（端口 1420）并在结束时关闭。
 * 输出目录：docs/verification/ui（可用 LIGHTINK_CAPTURE_OUT 覆盖）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const out = process.env.LIGHTINK_CAPTURE_OUT ?? `${root}/docs/verification/ui`;
// Vite 默认只绑定 localhost（Windows 上解析到 ::1），因此探测与访问统一用 localhost。
const baseUrl = process.env.LIGHTINK_PREVIEW_URL ?? 'http://localhost:1420';
const locale = process.env.LIGHTINK_CAPTURE_LOCALE ?? 'zh-CN';
const widths = (process.env.LIGHTINK_CAPTURE_WIDTHS ?? '1280,900,640').split(',').map(Number);
const themes = (process.env.LIGHTINK_CAPTURE_THEMES ?? 'warm-light,dark').split(',');
const headless = process.env.LIGHTINK_CAPTURE_HEADED !== '1';
const aiConfigured = process.env.LIGHTINK_CAPTURE_AI === '1';
fs.mkdirSync(out, { recursive: true });

const failures = [];
const captures = [];
const record = (entry) => {
  failures.push(entry);
  console.log('FAIL', JSON.stringify(entry));
};

/** 非关键交互失败不中断整套矩阵，只记录失败。 */
async function attempt(label, fn) {
  try {
    await fn();
    return true;
  } catch (error) {
    const text = String(error).replace(/\u001b\[[0-9;]*m/g, '');
    // Playwright 的拦截说明在日志尾部（"<div ...> intercepts pointer events"），保留尾部。
    const detail = text.slice(-420).replace(/\s+/g, ' ');
    record({ label, error: detail });
    return false;
  }
}

/** 步骤失败时报告盖住视口的大面积浮层，便于定位「点击被拦截」。 */
async function obstructionReport(page) {
  return page.evaluate(() => {
    const center = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    const overlays = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
        if (style.position !== 'fixed' && style.position !== 'absolute') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < innerWidth * 0.4 || rect.height < innerHeight * 0.4) return false;
        return rect.left <= 4 || rect.top <= 4;
      })
      .slice(0, 6)
      .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 70) }));
    const menus = [...document.querySelectorAll('[role="menu"], .lightink-context-menu')].length;
    return { centerHit: center === null ? null : `${center.tagName}.${String(center.className).slice(0, 70)}`, overlays, menus };
  });
}

/** 步骤开始前清理意外弹窗（如打开失败的应用内 alert），避免阻塞后续交互。 */
async function clearStrayModals(page, shot, step) {
  const modal = page.locator('.lightink-modal-overlay .lightink-modal-dialog:visible').first();
  if ((await modal.count()) > 0) {
    const text = (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
    record({ label: 'stray-modal', step, text });
    await attempt(`stray-shot:${step}`, () => shot(`stray-${step.replace(/[^a-z0-9-]/gi, '_')}`));
    await page.keyboard.press('Escape').catch(() => undefined);
    if ((await modal.count()) > 0) {
      await modal.locator('button').last().click({ force: true, timeout: 2_000 }).catch(() => undefined);
    }
  }
  // 书库自定义浮层（分组勾选等）不在通用 modal 类名下，但同样会拦截全部点击。
  const membership = page.locator('.lightink-library-membership-overlay:not([hidden])').first();
  if ((await membership.count()) > 0) {
    record({ label: 'stray-membership', step });
    await page.keyboard.press('Escape').catch(() => undefined);
    if ((await membership.count()) > 0) {
      await page
        .locator('.lightink-library-membership-actions button')
        .last()
        .click({ force: true, timeout: 2_000 })
        .catch(() => undefined);
    }
    if ((await membership.count()) > 0) {
      // 点击浮层空白处（backdrop）关闭。
      await page.mouse.click(8, 8).catch(() => undefined);
      await page.waitForTimeout(150);
    }
  }
}

// ---------------------------------------------------------------------------
// 合成数据
// ---------------------------------------------------------------------------

const DRAFT_CONTENT = `# 轻墨设计笔记

> 让写作与阅读在同一个窗口里自然切换。

## 本周计划

- [x] 调整书架封面墙的行距与留白
- [ ] 打磨阅读器的翻页手感
- [ ] 校对导出 HTML 的公式样式

## 排版原则

正文保持**单栏**与可读行长，标题通过 \`rem\` 逐级缩放，而不是字号突变。

| 元素 | 字号 | 行高 |
| --- | --- | --- |
| 正文 | 16px | 1.75 |
| 引用 | 0.95em | 1.8 |

行内公式 $E = mc^2$ ，块级公式：

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

\`\`\`ts
const doc = await open('notes.md');
console.log(doc.title, doc.words);
\`\`\`

更多内容见 [LightInk 仓库](https://example.com/lightink)。

## 交互备忘

1. 选择文本时浮出格式工具条
2. 输入 \`/\` 打开插入菜单
3. \`Ctrl+J\` 一键切换深浅主题
`;

const BOOK_TEXT = `第一章 潮汐

傍晚的海面像一块缓慢呼吸的金属。潮水退去以后，滩涂上留下细密的纹路，风从纹路之间穿过，把白天的余温一层层带走。

远处的灯塔还没有亮。守塔人沿着堤岸慢慢走，手里的铜铃随着脚步轻响。他说潮汐有自己的记忆，每一次涨落都会把上一次的痕迹抹平，又重新写上新的。

第二章 灯

灯亮起来的时候，整片海面忽然安静了。光线越过水面，像一封写得很慢的信，一行一行地送到对岸。

我在堤岸上坐下来，看船舱里的灯火一盏盏点亮。有人在甲板上收网，有人在低声唱歌。歌声被风拆散，又重新拼好，落在水面上。

第三章 归途

夜更深了。潮水开始回头，把白天的脚印一一收走。

守塔人把最后一盏灯交给我，说：记住，灯不是为了让海看见，而是为了让人知道岸在哪里。

我沿着来时的路往回走。身后的光越来越小，却始终没有熄灭。

第四章 早班船

天快亮的时候，第一班船从雾里出来。甲板上堆着渔网和木箱，船工们彼此点头，像是交换了某个只有清晨才知道的消息。

码头的钟敲了六下。卖热汤的小摊支起棚子，蒸汽在冷空气里散开，路过的人会停下来，把手放在碗边取暖。

我买了票，坐在靠窗的位置。船离岸时，灯塔正好熄灭——它也需要休息。

第五章 靠岸

午后的风把云推得很低。岸边的孩子追着浪跑，又被浪赶回来，笑声一层一层地叠在防波堤上。

我把这几天的见闻写进本子：潮汐的时间、灯的角度、船工的口音。写完之后，忽然明白守塔人那句话的意思——记下来，就是岸。
`;

const BOOKS = [
  {
    id: 'book-dune',
    title: '沙丘',
    author: '弗兰克·赫伯特',
    cover: ['#c2703d', '#7a3b2e'],
    kind: 'text',
    extension: 'txt',
    localPath: 'C:/Books/dune.txt',
    progress: { index: 2, ratio: 0.35, total: 6, title: '第二章 灯' },
    subjects: ['科幻', '史诗'],
    updatedAt: 1790758800,
  },
  {
    id: 'book-prince',
    title: '小王子',
    author: '安托万·德·圣埃克苏佩里',
    cover: ['#2f6f8f', '#183a4d'],
    kind: 'text',
    extension: 'epub',
    localPath: 'C:/Books/the-little-prince.epub',
    progress: { index: 8, ratio: 0.92, total: 9, title: '第 27 章' },
    subjects: ['童话'],
    updatedAt: 1790738800,
  },
  {
    id: 'book-mist',
    title: '迷雾中的旅人',
    author: '林一舟',
    cover: ['#5b6b4f', '#2f3a29'],
    kind: 'text',
    extension: 'epub',
    localPath: 'C:/Books/mist.epub',
    progress: null,
    subjects: ['小说'],
    updatedAt: 1790718800,
  },
  {
    id: 'book-atlas',
    title: '星图与潮汐',
    author: '陈见山',
    cover: ['#6a5a86', '#332a45'],
    kind: 'comic',
    extension: 'cbz',
    localPath: 'C:/Books/atlas.cbz',
    progress: { index: 12, ratio: 0.1, total: 80, title: '第 12 页' },
    subjects: ['漫画'],
    updatedAt: 1790708800,
  },
  {
    id: 'book-notes',
    title: '人类简史',
    author: '尤瓦尔·赫拉利',
    cover: ['#a8862f', '#5f4a1a'],
    kind: 'text',
    extension: 'pdf',
    localPath: 'C:/Books/sapiens.pdf',
    progress: null,
    subjects: ['历史'],
    updatedAt: 1790698800,
  },
];

const svgCover = (title, author, from, to) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="460">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
      `</linearGradient></defs>` +
      `<rect width="320" height="460" fill="url(#g)"/>` +
      `<rect x="0" y="0" width="10" height="460" fill="rgba(0,0,0,.25)"/>` +
      `<text x="30" y="150" font-family="'Microsoft YaHei',serif" font-size="38" fill="rgba(255,255,255,.96)">${title}</text>` +
      `<text x="30" y="200" font-family="'Microsoft YaHei',sans-serif" font-size="19" fill="rgba(255,255,255,.72)">${author}</text>` +
      `<rect x="30" y="380" width="60" height="4" rx="2" fill="rgba(255,255,255,.5)"/>` +
      `</svg>`,
  );

// ---------------------------------------------------------------------------
// 页面内 mock：window.__TAURI_INTERNALS__（Tauri v2 IPC 表面）
// ---------------------------------------------------------------------------

export function installFixtures({
  theme,
  locale,
  books,
  draft,
  bookText,
  libraryTheme,
  readerTheme,
  aiConfigured = false,
}) {
  const encoder = new TextEncoder();
  const bookBytes = encoder.encode(bookText);
  const now = Date.now();
  const callbacks = new Map();
  let callbackId = 0;
  const histories = new Map();
  // Capture-only controls; each page gets an isolated in-memory AI session.
  window.__LIGHTINK_CAPTURE_AI__ = { scenario: 'reply' };

  localStorage.setItem('lightink.locale', locale);
  if (theme !== undefined && theme !== '') {
    localStorage.setItem('lightink.theme', theme);
  }
  if (libraryTheme !== undefined && libraryTheme !== '') {
    localStorage.setItem('lightink.library.theme', libraryTheme);
  }
  if (readerTheme !== undefined && readerTheme !== '') {
    localStorage.setItem('lightink.reader.theme', readerTheme);
  }
  localStorage.setItem('lightink.statusBar.visible', 'true');
  localStorage.setItem('lightink.chrome.pinned', JSON.stringify({ menu: true, tabs: true }));
  for (const book of books) {
    if (book.progress !== null) {
      localStorage.setItem(
        `lightink.reader.progress.${book.id}`,
        JSON.stringify({ version: 2, kind: 'flow', ...book.progress, updatedAt: now }),
      );
      localStorage.setItem(`lightink.library.progressAlias.${book.id}`, book.id);
    }
  }

  const items = books.map((book, index) => ({
    id: book.id,
    sourceId: undefined,
    sourceKind: 'local',
    title: book.title,
    authors: [book.author],
    coverUrl: book.cover,
    localPath: book.localPath,
    acquisitionUrl: undefined,
    mediaType: undefined,
    extension: book.extension,
    size: 1024 * (400 + index * 137),
    etag: undefined,
    lastModified: undefined,
    series: undefined,
    number: undefined,
    volume: undefined,
    pageCount: book.kind === 'comic' ? 80 : undefined,
    readingDirection: book.kind === 'comic' ? 'rtl' : undefined,
    coverPage: undefined,
    blobHash: undefined,
    offlinePinned: index === 0,
    subjects: book.subjects,
    updatedAt: book.updatedAt,
  }));

  const groups = [
    { id: 'group-fiction', parentId: undefined, name: '小说', kind: 'custom', sortOrder: 0 },
    { id: 'group-sci', parentId: 'group-fiction', name: '科幻', kind: 'custom', sortOrder: 1 },
    { id: 'group-reading', parentId: undefined, name: '在读短名单', kind: 'custom', sortOrder: 2 },
  ];
  const memberships = [
    { groupId: 'group-sci', itemId: 'book-dune' },
    { groupId: 'group-reading', itemId: 'book-dune' },
    { groupId: 'group-reading', itemId: 'book-atlas' },
  ];
  const tags = [
    { id: 'tag-night', name: '夜读', createdAt: now, updatedAt: now },
    { id: 'tag-trip', name: '旅途', createdAt: now, updatedAt: now },
  ];
  const tagMemberships = [
    { tagId: 'tag-night', itemId: 'book-dune' },
    { tagId: 'tag-trip', itemId: 'book-mist' },
  ];

  const fallback = () => null;

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    convertFileSrc: (path) => path,
    transformCallback(callback, once = false) {
      callbackId += 1;
      callbacks.set(callbackId, (data) => {
        if (once) callbacks.delete(callbackId);
        return callback(data);
      });
      return callbackId;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    runCallback(id, data) {
      const callback = callbacks.get(id);
      if (callback) callback(data);
    },
    async invoke(command, args = {}) {
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('plugin:dialog|open')) return 'C:/Notes/lightink-design.md';
      if (command.startsWith('plugin:dialog|save')) return 'C:/Exports/out.html';
      switch (command) {
        case 'take_pending_file':
          return null;
        case 'list_untitled_drafts':
          return [{ key: 'untitled-8f3a2c11', content: draft }];
        case 'read_stale_snapshot':
          return null;
        case 'list_recents':
          return ['C:/Books/dune.txt', 'C:/Notes/lightink-design.md'];
        case 'library_list_items':
          return items;
        case 'library_list_groups':
          return groups;
        case 'library_list_group_memberships':
          return memberships;
        case 'library_list_tags':
          return tags;
        case 'library_list_tag_memberships':
          return tagMemberships;
        case 'library_cache_stats':
          return { bytesCached: 734003200, limitBytes: 2147483648 };
        case 'opds_list_sources':
        case 'webdav_source_list':
        case 'book_source_list':
        case 'managed_document_list':
        case 'managed_document_list_drafts':
        case 'sync_list_conflicts':
          return [];
        case 'library_materialize_item': {
          const book = books.find((entry) => entry.id === args.itemId) ?? books[0];
          return { itemId: book.id, path: book.localPath, availability: 'local' };
        }
        case 'library_create_group': {
          const group = {
            id: `group-new-${groups.length}`,
            parentId: args.parentId,
            name: args.name,
            kind: 'custom',
            sortOrder: 9,
          };
          groups.push(group);
          return group;
        }
        case 'library_update_group':
          return { id: args.groupId, name: args.name, kind: 'custom', sortOrder: 0 };
        case 'library_create_tag':
          return { id: `tag-new-${Math.random().toString(36).slice(2, 7)}`, name: args.name, createdAt: now, updatedAt: now };
        case 'library_rename_tag':
          return { id: args.tagId, name: args.name, createdAt: now, updatedAt: now };
        case 'reader_file_size':
          return bookBytes.byteLength;
        case 'read_file_bytes': {
          const offset = Number(args.offset ?? 0);
          const length = args.length === undefined ? undefined : Number(args.length);
          return bookBytes.buffer.slice(
            offset,
            length === undefined ? bookBytes.byteLength : offset + length,
          );
        }
        case 'read_file':
        case 'read_version':
          return draft;
        case 'stat_file':
          return { mtime_ms: now, size: bookBytes.byteLength, fingerprint: 'capture-fp' };
        case 'content_hash':
          return 'capture-hash';
        case 'read_annotations':
        case 'book_translation_read_state':
          return '';
        case 'assistant_read_history':
          return histories.get(args.contentHash) ?? '';
        case 'assistant_write_history':
          histories.set(args.contentHash, args.json);
          return null;
        case 'assistant_clear_history':
          histories.delete(args.contentHash);
          return null;
        case 'sync_get_profile':
          return null;
        case 'sync_device_id':
          return 'capture-device';
        case 'managed_document_save_draft':
          return {
            id: 'draft-capture-1',
            documentId: undefined,
            blobHash: 'capture-blob',
            title: undefined,
            deviceId: 'capture-device',
            createdAt: now,
            updatedAt: now,
          };
        case 'list_versions':
          return [
            { id: 'v-3', created_at_ms: now - 3600_000 },
            { id: 'v-2', created_at_ms: now - 86_400_000 },
            { id: 'v-1', created_at_ms: now - 3 * 86_400_000 },
          ];
        case 'create_version':
          return { id: 'v-4', created_at_ms: now };
        case 'ai_get_config':
          return {
            endpointKind: 'openai-chat',
            baseUrl: aiConfigured ? 'https://ai.example.test/v1' : '',
            model: aiConfigured ? 'capture-model' : '',
            allowHttp: false,
            targetLang: undefined,
            hasKey: aiConfigured,
            configured: aiConfigured,
            missing: aiConfigured ? [] : ['baseUrl', 'model'],
            defaults: [{ endpointKind: 'openai-chat', baseUrl: 'https://api.openai.com/v1' }],
          };
        case 'ai_test_connection':
          return { latencyMs: 248, reply: 'OK' };
        case 'ai_translate_selection':
          if (!aiConfigured) throw new Error('AI_NOT_CONFIGURED');
          return {
            text: 'At dusk, the sea was like a sheet of slowly breathing metal. As the tide receded, delicate patterns remained on the shore, carrying away the warmth of the day.',
            targetLang: args.targetLang,
            truncated: false,
          };
        case 'ai_chat_stream': {
          if (!aiConfigured) throw new Error('AI_NOT_CONFIGURED');
          const scenario = window.__LIGHTINK_CAPTURE_AI__.scenario;
          await new Promise((resolve) => setTimeout(resolve, 450));
          if (scenario === 'error') throw new Error('AI_NETWORK_ERROR');
          if (scenario === 'tool-search' || scenario === 'tool-pending') {
            window.__LIGHTINK_CAPTURE_AI__.scenario = 'reply';
            const call = scenario === 'tool-search'
              ? { id: 'capture-search', name: 'library_search', arguments: JSON.stringify({ action: 'books', query: '沙丘' }) }
              : { id: 'capture-group', name: 'library_create_group', arguments: JSON.stringify({ name: 'AI 阅读计划' }) };
            window.__TAURI_INTERNALS__.runCallback(args.onEvent.id, { index: 0, message: { type: 'tool_call', ...call } });
            window.__TAURI_INTERNALS__.runCallback(args.onEvent.id, { index: 1, end: true });
            return { finish: 'tool_calls', totalChars: 0, toolCalls: [call] };
          }
          const reply = locale === 'en'
            ? '### Reading notes\n\nThe passage connects **tides, light, and memory**.\n\n- The tide suggests change and renewal.\n- The lighthouse gives the traveller a sense of direction.\n- Writing preserves the journey.\n\n> Writing it down is a way of finding the shore.\n\nYou can ask about the imagery or make a short reading plan.'
            : '### 阅读笔记\n\n这段文字围绕**潮汐、灯光与记忆**展开。\n\n- **潮汐**：用反复涨落表现时间与变化。\n- **灯塔**：为旅人提供方向，也象征人与人的联系。\n- **记录**：把短暂的见闻变成可以重温的记忆。\n\n> 记下来，就是岸。\n\n可以继续讨论其中的意象，或整理成简短的读书笔记。';
          let index = 0;
          for (const text of reply.match(/.{1,18}|\n/g) ?? []) {
            if (!callbacks.has(args.onEvent.id)) throw new Error('AI_STREAM_ABORTED');
            window.__TAURI_INTERNALS__.runCallback(args.onEvent.id, { index: index++, message: { type: 'delta', text } });
            await new Promise((resolve) => setTimeout(resolve, scenario === 'slow' ? 180 : 18));
          }
          window.__TAURI_INTERNALS__.runCallback(args.onEvent.id, { index, end: true });
          return { finish: 'stop', totalChars: reply.length, toolCalls: [] };
        }
        case 'conceal_get_status':
          return { trayAvailable: false, trayError: null, bossPrimary: null, bossSecondary: null };
        case 'conceal_register_boss_keys':
          return { primary: null, secondary: null, primaryError: null, secondaryError: null };
        default:
          return fallback();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

/**
 * `lightink` = 本仓库 dev server；`foreign` = 端口被其他应用占用（此时绝不能截图）；
 * `down` = 没有服务在监听。
 */
async function probeDevServer() {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
    if (!(response.ok || response.status < 500)) return 'foreign';
    const html = await response.text();
    return html.includes('src="/src/main.ts"') ? 'lightink' : 'foreign';
  } catch {
    return 'down';
  }
}

export async function ensureDevServer() {
  if (process.env.LIGHTINK_PREVIEW_URL !== undefined) return null;
  const probe = await probeDevServer();
  if (probe === 'lightink') return null;
  if (probe === 'foreign') {
    throw new Error(
      `${baseUrl} 被其他进程占用（返回的 HTML 不是 LightInk）。请先释放 1420 端口，` +
        '或用 LIGHTINK_PREVIEW_URL 指向 LightInk dev server，避免截到其他应用。',
    );
  }
  console.log('dev server 未运行，正在启动 vite ...');
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--port', '1420', '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[dev] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[dev] ${chunk}`));
  // 冷启动（依赖预构建）可能持续数分钟。
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('dev server 启动超时');
    }
    if ((await probeDevServer()) === 'lightink') return child;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function shoot(page, width, theme, name) {
  await page.waitForTimeout(140);
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  const path = `${out}/${name}-${theme}-${width}.png`;
  await page.screenshot({ path });
  captures.push({ name, theme, width, path });
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('main,section,article,input,textarea,select,button,a,label,h1,h2,h3')]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > innerWidth + 1)
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className ?? '').slice(0, 60),
        text: (el.textContent ?? '').trim().slice(0, 50),
      })),
  );
  if (overflow.length) record({ label: 'overflow', name, theme, width, overflow });
  console.log(path);
}

/** 预热一次：让 dev server 完成依赖预构建并拉取 katex/高亮等按需 chunk。 */
async function warmUp(browser, fixtureArgs) {
  console.log('预热 dev server 依赖 ...');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6_000);
  await page.addInitScript(installFixtures, fixtureArgs);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await attempt('warmup:recovery', async () => {
    const dialog = page.locator('.lightink-modal-dialog:visible').first();
    await dialog.waitFor({ timeout: 20_000 });
    await dialog.locator('.lightink-modal-btn--primary').click();
  });
  await attempt('warmup:shelf', () =>
    page.waitForSelector('.lightink-library:not([hidden]) .lightink-library-header', { timeout: 30_000 }),
  );
  await attempt('warmup:editor', async () => {
    await page.evaluate(() => document.getElementById('lightink-enter-editor')?.click());
    await page.waitForSelector('.ProseMirror', { timeout: 15_000 });
    await page.waitForTimeout(1_500);
  });
  await page.close();
}

/** 编辑器主题 → 书架/阅读器主题，让暗色矩阵截到暗色表面。 */
function fixtureSurfaceThemes(theme) {
  const dark = theme === 'dark' || theme === 'midnight' || theme.endsWith('-dark');
  return {
    libraryTheme: process.env.LIGHTINK_CAPTURE_LIBRARY_THEME ?? (dark ? 'ink' : 'gallery'),
    readerTheme: process.env.LIGHTINK_CAPTURE_READER_THEME ?? (dark ? 'night' : 'sepia'),
  };
}

async function captureMatrix(browser, width, theme, fixtureArgs) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  // 交互失败快速失败，避免一个卡住的点击拖垮整套矩阵。
  page.setDefaultTimeout(6_000);
  const shot = (name) => shoot(page, width, theme, name);
  const step = async (label, fn) => {
    const started = Date.now();
    const ok = await attempt(label, fn);
    if (!ok) {
      await attempt(`${label}:obstruction`, async () => {
        record({ label: `${label}:obstruction`, theme, width, ...(await obstructionReport(page)) });
      });
    }
    await clearStrayModals(page, shot, label);
    console.log(`  · ${label} ${ok ? 'ok' : 'FAIL'} (${Date.now() - started}ms)`);
    return ok;
  };
  const openMenu = async (menuId) => {
    await page.keyboard.press('Escape');
    await page.locator(`.lightink-menu-trigger[data-menu-id="${menuId}"]`).click();
    await page.locator(`.lightink-menu-panel[data-menu-id="${menuId}"]`).waitFor({ state: 'visible' });
  };
  const clickMenuItem = (itemId) =>
    page.locator(`.lightink-menu-item[data-item-id="${itemId}"]:visible`).first().click();
  /** 活动标签的内容宿主（多标签时避免命中隐藏 tab 的编辑器）。 */
  const activeHost = async () => {
    const id = await page
      .locator('#lightink-tabbar [role="tab"][aria-selected="true"]')
      .getAttribute('aria-controls');
    return id === null ? null : `#${id}`;
  };
  page.on('pageerror', (error) => record({ label: 'pageerror', theme, width, error: String(error).slice(0, 300) }));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('favicon') || text.includes('Failed to load resource: the server responded with a status of 404')) return;
    // 章节 iframe 使用 sandbox srcdoc（不含 allow-scripts），Chromium 会输出该拦截提示。
    if (text.includes("Blocked script execution in 'about:srcdoc'")) return;
    // dev server 重启期间的 HMR 重连噪音与页面状态无关。
    if (text.includes('[vite]') || text.includes('WebSocket connection to')) return;
    // 首次访问触发的依赖重优化（504 Outdated Optimize Dep）是 dev server 冷启动产物。
    if (text.includes('Outdated Optimize Dep')) return;
    record({ label: 'console', theme, width, error: text.slice(0, 300) });
  });
  await page.addInitScript(installFixtures, { ...fixtureArgs, theme, ...fixtureSurfaceThemes(theme) });

  // 启动：先出现崩溃恢复确认对话框，再进入书架。
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await step('boot:recovery-dialog', async () => {
    const dialog = page.locator('.lightink-modal-dialog:visible').first();
    await dialog.waitFor({ timeout: 20_000 });
    await shot('recovery');
    await dialog.locator('.lightink-modal-btn--primary').click();
  });
  await page.waitForSelector('.lightink-library:not([hidden]) .lightink-library-header', { timeout: 30_000 });
  // 书架表面会隐藏标签栏（hidden + inert），因此只等待节点挂载。
  await page.waitForSelector('#lightink-tabbar [role="tab"]', { state: 'attached', timeout: 30_000 });

  // 详情面板（含「标为读完」等按钮）在窄窗口会盖住书卡；每次用后显式关闭。
  const closeDetail = async () => {
    const detail = page.locator('.lightink-library-detail:not([hidden])').first();
    if ((await detail.count()) === 0) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    if ((await detail.count()) > 0) {
      await page.locator('.lightink-library-detail-close:visible').first().click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(150);
    }
  };

  // 书架
  await shot('shelf');
  const assistant = () => page.locator('.lightink-reader-assistant-panel:visible').first();
  const closeAssistant = async () => {
    if (await assistant().count()) await assistant().locator('.lightink-reader-assistant-close').click();
  };
  const askAssistant = async (prompt, scenario = 'reply') => {
    await page.evaluate((value) => { window.__LIGHTINK_CAPTURE_AI__.scenario = value; }, scenario);
    await assistant().locator('.lightink-reader-assistant-input').fill(prompt);
    await assistant().locator('.lightink-reader-assistant-send').click();
  };
  const waitForReply = () => assistant().locator('.is-assistant').last().and(
    assistant().locator('[data-status="done"]'),
  ).waitFor({ timeout: 12_000 });
  if (aiConfigured) await step('ai:shelf', async () => {
    try {
      await page.locator('.lightink-library-header-assistant').click();
      await assistant().locator('.lightink-reader-assistant-input').waitFor();
      await shot('ai-shelf-empty');
      await askAssistant(locale === 'en' ? 'Suggest a reading plan.' : '帮我安排本周的阅读计划。', 'slow');
      await assistant().locator('[data-status="streaming"]').waitFor();
      await shot('ai-shelf-streaming');
      await waitForReply();
      await shot('ai-shelf-reply');
      await assistant().locator('.lightink-reader-assistant-history-toggle').click();
      await shot('ai-history');
      await assistant().locator('.lightink-reader-assistant-history-toggle').click();
      await askAssistant(locale === 'en' ? 'Summarize the key points.' : '再归纳一下重点。', 'error');
      await assistant().locator('[data-status="error"]').waitFor();
      await shot('ai-error');
      await page.evaluate(() => { window.__LIGHTINK_CAPTURE_AI__.scenario = 'reply'; });
      await assistant().locator('.lightink-reader-assistant-retry').last().click();
      await waitForReply();
      await shot('ai-retry');
      await askAssistant(locale === 'en' ? 'Expand the reading notes.' : '详细展开这些读书笔记。', 'slow');
      await assistant().locator('[data-status="streaming"]').waitFor();
      await assistant().locator('.lightink-reader-assistant-stop').click();
      await assistant().locator('[data-status="stopped"]').waitFor();
      await shot('ai-stopped');
      await askAssistant(locale === 'en' ? 'Find Dune in my library.' : '在书库里查找沙丘。', 'tool-search');
      await waitForReply();
      await assistant().locator('.lightink-reader-assistant-tool-head').last().click();
      await shot('ai-tool-search');
      await askAssistant(locale === 'en' ? 'Create a collection called AI 阅读计划.' : '创建一个名为 AI 阅读计划 的分组。', 'tool-pending');
      await assistant().locator('.lightink-reader-assistant-pending:not([hidden])').waitFor();
      await waitForReply();
      await shot('ai-tool-confirmation');
      await assistant().locator('.lightink-reader-assistant-pending-confirm').click();
      await assistant().locator('.is-assistant[data-status="waiting"], .is-assistant[data-status="streaming"]').waitFor();
      await waitForReply();
      await shot('ai-tool-confirmed');
    } finally {
      await closeAssistant();
    }
  });
  await step('shelf:menu', async () => {
    await page.locator('.lightink-library-item--cover').first().click({ button: 'right' });
    const menu = page.locator('[role="menu"]:visible').first();
    await menu.waitFor({ timeout: 5_000 });
    await shot('shelf-menu');
    const details = menu.locator('[role="menuitem"]', { hasText: /详情|Details/ }).first();
    if ((await details.count()) > 0) {
      await details.click();
    } else {
      await page.keyboard.press('Escape');
      return;
    }
    await page.locator('.lightink-library-detail:not([hidden])').waitFor({ timeout: 5_000 });
    await page.mouse.move(width / 2, 500);
    await shot('shelf-detail');
    await closeDetail();
  });
  await step('shelf:hover', async () => {
    await closeDetail();
    const card = page.locator('.lightink-library-item--cover').first();
    if ((await card.count()) === 0 || !(await card.isVisible().catch(() => false))) {
      record({ label: 'shelf:hover-skipped', theme, width });
      return;
    }
    await card.hover();
    await shot('shelf-hover');
  });
  await step('shelf:search', async () => {
    await page.locator('.lightink-library-search input[role="searchbox"]').fill('沙');
    await page.waitForTimeout(250);
    await shot('shelf-search');
    await page.locator('.lightink-library-search input[role="searchbox"]').fill('');
  });

  // 左侧分组：分区展开（桌面先悬停标题露出筛选按钮，打开筛选即展开分区）/ 分组筛选 /
  // 分组管理菜单 / 新建子分组 / 智能分组 / 右键「加入分组」勾选（分组标记）
  const revealSection = async (filterToggleClass, bodySelector) => {
    const body = page.locator(bodySelector).first();
    if ((await body.count()) > 0 && (await body.isVisible().catch(() => false))) return;
    // 桌面端分区操作按钮仅在该标题 hover 时可见（pointer-events: none），
    // 必须先悬停标题，Playwright 才能命中按钮。
    const heading = page
      .locator('.lightink-library-pane-heading')
      .filter({ has: page.locator(`.${filterToggleClass}`) })
      .first();
    await heading.hover();
    await page.waitForTimeout(150);
    await page.locator(`.${filterToggleClass}`).first().click({ timeout: 4_000 });
    await page.waitForTimeout(250);
  };
  await step('library:groups', async () => {
    await revealSection('lightink-library-group-filter-toggle', '.lightink-library-group-body');
    await shot('library-groups');
    // 分组筛选：输入即过滤分组树
    const filterInput = page.locator('.lightink-library-group-filter').first();
    if ((await filterInput.count()) > 0 && (await filterInput.isVisible().catch(() => false))) {
      await filterInput.fill('科');
      await page.waitForTimeout(250);
      await shot('library-groups-filter');
      await filterInput.fill('');
      await page.waitForTimeout(150);
    }
  });
  await step('library:group-select', async () => {
    const toggle = page.locator('.lightink-library-custom-group[data-group-id="group-fiction"] .lightink-library-group-toggle').first();
    if ((await toggle.count()) > 0) {
      await toggle.click();
      await page.waitForTimeout(250);
    }
    await page.locator('button.lightink-library-group[data-custom-group-id="group-sci"]').first().click();
    await page.waitForTimeout(300);
    await shot('library-group-filter');
  });
  const openGroupMenu = async (groupId) => {
    const row = page.locator(`.lightink-library-custom-group[data-group-id="${groupId}"]`).first();
    await row.hover();
    await page.waitForTimeout(120);
    await row.locator('.lightink-library-group-menu').click();
    const menu = page.locator('[role="menu"]:visible').first();
    await menu.waitFor();
    return menu;
  };
  // 上下文菜单靠「外部 pointerdown」关闭；Escape 之外再点一次空白内容区兜底，
  // 否则遗留菜单会拦截后续所有点击。
  const dismissMenus = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    if ((await page.locator('[role="menu"]:visible').count()) > 0) {
      await page.mouse.click(width / 2, height - 160);
      await page.waitForTimeout(150);
    }
  };
  await step('library:group-menu', async () => {
    await openGroupMenu('group-fiction');
    await shot('library-group-menu');
    await dismissMenus();
  });
  await step('library:group-create', async () => {
    // 用分区「+」按钮打开新建分组弹窗（分组「...」菜单已在上一张截图覆盖）。
    const addButton = page.locator('.lightink-library-group-add').first();
    await addButton.hover().catch(() => undefined);
    await page.waitForTimeout(120);
    await addButton.click({ timeout: 4_000 });
    await page.locator('.lightink-library-group-modal:visible').first().waitFor();
    await page.locator('.lightink-library-group-form input[name="name"]').fill('星海');
    await page.waitForTimeout(150);
    await shot('library-group-create');
    await page.locator('.lightink-library-group-form-actions button').first().click();
    await page.waitForTimeout(400);
    await shot('library-group-created');
  });
  await step('library:smart-group', async () => {
    await revealSection('lightink-library-smart-group-filter-toggle', '.lightink-library-smart-group-body');
    // 「格式 / 作者 / 系列」子块默认收起：逐个展开后再选第一个智能分组。
    const typeToggles = page.locator('.lightink-library-smart-type-heading .lightink-library-collapse-toggle');
    const typeCount = await typeToggles.count();
    for (let index = 0; index < typeCount; index += 1) {
      const toggle = typeToggles.nth(index);
      if ((await toggle.getAttribute('aria-expanded')) === 'false') {
        await toggle.click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(120);
      }
    }
    const row = page.locator('.lightink-library-smart-group:visible').first();
    if ((await row.count()) === 0) {
      record({ label: 'library:smart-group-empty', theme, width });
      return;
    }
    await row.click();
    await page.waitForTimeout(300);
    await shot('library-smart-group');
  });
  await step('library:membership', async () => {
    await page.locator('.lightink-library-group[data-shelf-group="all"]').first().click();
    await page.waitForTimeout(250);
    // 优先用 沙丘：它已属于两个分组，勾选状态正是「分组标记」要检查的内容。
    const hero = page.locator('.lightink-library-continue-open[data-item-id="book-dune"]');
    const card = page.locator('.lightink-library-item--cover[data-item-id="book-dune"]');
    if ((await hero.count()) > 0) await hero.first().click({ button: 'right' });
    else if ((await card.count()) > 0) await card.first().click({ button: 'right' });
    else await page.locator('.lightink-library-item--cover').first().click({ button: 'right' });
    const menu = page.locator('[role="menu"]:visible').first();
    await menu.waitFor();
    await menu.locator('[role="menuitem"]', { hasText: /加入分组|Add to group/ }).first().click();
    await page.locator('.lightink-library-membership-dialog:visible').first().waitFor();
    await page.waitForTimeout(200);
    await shot('library-membership');
    await page.locator('.lightink-library-membership-actions button').last().click();
    await page
      .locator('.lightink-library-membership-overlay:not([hidden])')
      .first()
      .waitFor({ state: 'hidden', timeout: 3_000 });
  });
  await step('shelf:manage', async () => {
    await page.locator('.lightink-library-manage-entry').click();
    await page.waitForTimeout(300);
    await shot('manage');
    const group = (pattern) => page.locator('.lightink-library-manage-group h2', { hasText: pattern }).first();
    await group(/外观|Appearance/).click();
    await page.waitForTimeout(250);
    await shot('manage-appearance');
    await group(/外观|Appearance/).click();
    await group(/^AI/).click();
    await page.waitForTimeout(250);
    await shot('manage-ai');
    if (aiConfigured) {
      await page.locator('.lightink-library-ai-test').click();
      await page.locator('.lightink-library-ai-feedback').filter({ hasText: /连接成功|Connection succeeded/ }).waitFor();
      await shot('ai-connection');
    }
    await group(/^AI/).click();
    // 摸鱼组：后台运行开关位于「退出」子组，默认关闭。
    await group(/摸鱼|Stealth/).click();
    await page.waitForTimeout(250);
    await shot('manage-conceal');
    const exitHeading = page.locator('[data-conceal-group="exit"] h3').first();
    await exitHeading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await shot('manage-conceal-exit');
    await group(/摸鱼|Stealth/).click();
    // 「其他」分组里是 Markdown 编辑入口，展开后交给下一步。
    await group(/其他|Other/).click();
    await page.waitForTimeout(250);
  });

  // 编辑器
  await step('editor:enter', async () => {
    const entry = page.locator('.lightink-library-editor-entry');
    if ((await entry.count()) > 0 && (await entry.first().isVisible().catch(() => false))) {
      await entry.first().click();
    } else {
      await page.evaluate(() => document.getElementById('lightink-enter-editor')?.click());
    }
    await page.waitForSelector('.lightink-tab-host[role="tabpanel"] .ProseMirror', { timeout: 15_000 });
    await page.locator('#lightink-editor-assistant').waitFor({ state: aiConfigured ? 'visible' : 'hidden' });
    await page.waitForTimeout(600);
    await shot('editor');
  });
  await step('editor:menu-file', async () => {
    await openMenu('file');
    await shot('editor-menu-file');
    await page.keyboard.press('Escape');
  });
  await step('editor:open-file', async () => {
    // 经「文件 → 打开」打开磁盘 Markdown：文件标签才启用版本历史等路径能力。
    await openMenu('file');
    await clickMenuItem('file-open');
    await page.waitForFunction(
      () => document.querySelectorAll('#lightink-tabbar [role="tab"]').length >= 2,
      undefined,
      { timeout: 8_000 },
    );
    await page.waitForTimeout(500);
    await shot('editor-file-tab');
  });
  await step('editor:find', async () => {
    await page.keyboard.press('Control+f');
    await page.locator('.lightink-find-panel.is-open').waitFor({ timeout: 5_000 });
    await page.locator('.lightink-find-input').fill('排版');
    await page.waitForTimeout(200);
    await shot('editor-find');
    await page.keyboard.press('Escape');
  });
  if (aiConfigured) await step('ai:editor', async () => {
    try {
      await page.locator('#lightink-editor-assistant').click();
      await assistant().locator('.lightink-reader-assistant-input').waitFor();
      await shot('ai-editor-context');
      await askAssistant(locale === 'en' ? 'Summarize this document.' : '总结这份文档的重点。');
      await waitForReply();
      await shot('ai-editor-reply');
    } finally {
      await closeAssistant();
    }
  });
  await step('editor:format-toolbar', async () => {
    const host = await activeHost();
    await page.locator(`${host} .ProseMirror p`).nth(1).click({ clickCount: 3 });
    await page.locator('.lightink-format-toolbar:visible').first().waitFor({ timeout: 5_000 });
    await shot('editor-format-toolbar');
  });
  await step('editor:slash', async () => {
    const host = await activeHost();
    await page.locator(`${host} .ProseMirror`).first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.locator('.lightink-slash-menu').waitFor({ state: 'visible', timeout: 5_000 });
    await shot('editor-slash');
    await page.keyboard.press('Escape');
  });
  await step('editor:source', async () => {
    const host = await activeHost();
    await page.keyboard.press('Control+/');
    await page.locator(`${host} textarea.lightink-source-editor`).waitFor({ timeout: 5_000 });
    await shot('editor-source');
    await page.keyboard.press('Control+/');
  });
  await step('editor:cheatsheet', async () => {
    await openMenu('help');
    await clickMenuItem('help-cheatsheet');
    await page.locator('.lightink-modal-dialog:visible').first().waitFor();
    await shot('cheatsheet');
    await page.keyboard.press('Escape');
    await page.locator('.lightink-modal-overlay:visible').first().waitFor({ state: 'hidden' });
  });
  await step('editor:versions', async () => {
    await openMenu('file');
    await clickMenuItem('file-versions');
    await page.locator('.lightink-versions-dialog').waitFor();
    await page.locator('.lightink-versions-item').first().click();
    await page.waitForTimeout(200);
    await shot('versions');
    await page.keyboard.press('Escape');
    await page.locator('.lightink-versions-dialog').waitFor({ state: 'hidden' });
  });
  await step('editor:sync', async () => {
    await openMenu('file');
    await clickMenuItem('file-sync-settings');
    await page.locator('.lightink-sync-dialog').waitFor();
    await shot('sync');
    await page.keyboard.press('Escape');
    await page.locator('.lightink-sync-dialog').waitFor({ state: 'hidden' });
  });

  // 阅读器
  const readerPanel = (name) => page.locator(`.lightink-reader-chrome-panel[data-panel="${name}"]`);
  const revealReaderChrome = async () => {
    await page.mouse.move(width / 2, 400);
    await page.mouse.move(width / 2, 30, { steps: 6 });
    await page.waitForTimeout(200);
    await page.mouse.move(width / 2, 22, { steps: 3 });
    await page.waitForTimeout(300);
  };
  const closeReaderPanel = async (name) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await readerPanel(name).isVisible().catch(() => false)) {
      await page.locator(`.lightink-reader-chrome-action--${name}`).click().catch(() => undefined);
      await page.waitForTimeout(200);
    }
  };
  await step('reader:open', async () => {
    const back = page.locator('#lightink-enter-reader-home');
    if (await back.isVisible().catch(() => false)) {
      await back.click();
    } else {
      await page.evaluate(() => document.getElementById('lightink-enter-reader-home')?.click());
    }
    await page.waitForSelector('.lightink-library:not([hidden])', { timeout: 10_000 });
    // 管理页不渲染书卡：先切回书架分区。
    await attempt('reader:shelf-filter', async () => {
      await page.locator('.lightink-library-group[data-shelf-group="all"]').first().click({ timeout: 5_000 });
    });
    await page.waitForSelector('.lightink-library-items', { timeout: 10_000 });
    // 打开 txt fixture（继续阅读 hero 或封面卡）：面板里的 epub/cbz 只是展示数据。
    const hero = page.locator('.lightink-library-continue-open[data-item-id="book-dune"]');
    if ((await hero.count()) > 0) {
      await hero.first().click();
    } else {
      await page.locator('.lightink-library-item--cover[data-item-id="book-dune"]').first().click();
    }
    await page.waitForSelector('.lightink-reader[data-reader-state="ready"]', { timeout: 20_000 });
    await page.waitForTimeout(600);
    await revealReaderChrome();
    if ((await page.locator('.lightink-reader-chrome[data-revealed="true"]').count()) === 0) {
      record({ label: 'reader:chrome-not-revealed', theme, width });
    }
    const chapterFrame = page.frames().find((entry) => entry !== page.mainFrame() && entry.url().startsWith('about:srcdoc'));
    const readerDiag = await page.evaluate(() => ({
      layout: document.documentElement.dataset.readingLayout,
      touchPrimary: document.documentElement.hasAttribute('data-touch-primary'),
      display: document.documentElement.dataset.display,
      innerWidth: window.innerWidth,
    }));
    const frameDiag =
      chapterFrame === undefined
        ? null
        : await chapterFrame.evaluate(() => {
            const spread = document.querySelector('.lightink-reader-spread');
            const style = spread === null ? null : getComputedStyle(spread);
            return {
              columnWidth: style?.columnWidth,
              columnCount: style?.columnCount,
              paragraphWidth: Math.round(document.querySelector('p')?.getBoundingClientRect().width ?? 0),
            };
          });
    console.log(`    reader diag: ${JSON.stringify({ ...readerDiag, ...frameDiag })}`);
    await shot('reader');
  });
  await step('reader:toc', async () => {
    await revealReaderChrome();
    await page.locator('.lightink-reader-chrome-action--toc').click();
    await readerPanel('toc').waitFor({ state: 'visible' });
    await shot('reader-toc');
    await closeReaderPanel('toc');
  });
  await step('reader:typography', async () => {
    await revealReaderChrome();
    await page.locator('.lightink-reader-chrome-action--typography').click();
    await readerPanel('typography').waitFor({ state: 'visible' });
    // Viewport overflow alone misses controls clipped inside a popover.
    const clipped = await readerPanel('typography').evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      return [...panel.querySelectorAll('.lightink-reader-type-step')]
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left < box.left || rect.right > box.right;
        })
        .map((button) => button.getAttribute('aria-label'));
    });
    if (clipped.length) record({ label: 'reader:typography-clipped', theme, width, clipped });
    await shot('reader-typography');
    await closeReaderPanel('typography');
  });
  const selectReaderText = async () => {
    await revealReaderChrome();
    // 章节正文在 sandbox iframe 内：在帧内建立 Range 选区，避免长会话下
    // 逐点拖动与遮蔽层动画的时序耦合。
    const frame = page.frames().find((entry) => entry !== page.mainFrame() && entry.url().startsWith('about:srcdoc'));
    if (frame === undefined) throw new Error('chapter frame not found');
    await frame.evaluate(() => {
      const paragraph = document.querySelectorAll('p')[1] ?? document.querySelector('p');
      if (paragraph === null) return;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = document.getSelection();
      if (selection === null) return;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    await page.locator('.lightink-reader-selection-toolbar').waitFor({ state: 'visible', timeout: 5_000 });
  };
  await step('reader:selection', async () => {
    await selectReaderText();
    await shot('reader-selection');
  });

  if (aiConfigured) {
    await step('ai:translation', async () => {
      try {
        await page.locator('.lightink-reader-selection-action--aiTranslate').click();
        await page.locator('.lightink-reader-lookup-lang').selectOption('en');
        await page.locator('.lightink-reader-lookup-line').filter({ hasText: 'At dusk' }).waitFor();
        await shot('ai-translation');
      } finally {
        const close = page.locator('.lightink-reader-lookup-close:visible');
        if (await close.count()) await close.click();
      }
    });
    await step('ai:reader-explain', async () => {
      try {
        await selectReaderText();
        await page.evaluate(() => { window.__LIGHTINK_CAPTURE_AI__.scenario = 'reply'; });
        await page.locator('.lightink-reader-selection-action--explain').click();
        await waitForReply();
        await shot('ai-reader-explain');
        await assistant().locator('.lightink-reader-assistant-new').click();
        await shot('ai-reader-new');
        await assistant().locator('.lightink-reader-assistant-action').first().click();
        await waitForReply();
        await shot('ai-reader-summary');
      } finally {
        await closeAssistant();
      }
    });
  }

  await page.close();
}

export function buildFixtureArgs(targetLocale = locale) {
  return {
    locale: targetLocale,
    books: BOOKS.map((book) => ({
      ...book,
      cover: svgCover(book.title, book.author, book.cover[0], book.cover[1]),
    })),
    draft: DRAFT_CONTENT,
    bookText: BOOK_TEXT,
    aiConfigured,
  };
}

async function main() {
  const server = await ensureDevServer();
  const browser = await chromium.launch({ headless });
  const fixtureArgs = buildFixtureArgs();
  try {
    await warmUp(browser, fixtureArgs);
    for (const width of widths) {
      for (const theme of themes) {
        console.log(`--- ${width}px · ${theme} ---`);
        await captureMatrix(browser, width, theme, fixtureArgs);
      }
    }
  } catch (error) {
    record({ label: 'capture:fatal', error: String(error).slice(0, 600) });
  } finally {
    await browser.close();
    if (server !== null) {
      server.kill();
      console.log('已关闭 dev server');
    }
  }

  console.log(JSON.stringify({ failures }, null, 2));
  fs.writeFileSync(`${out}/report.json`, JSON.stringify({ locale, aiConfigured, widths, themes, captures, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
