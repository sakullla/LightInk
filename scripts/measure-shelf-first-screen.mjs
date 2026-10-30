/**
 * 测量 1280×800 暖色浅色书架首屏。
 * 复用已有的 LightInk（http://localhost:1420）；否则自行启动 vite，结束时只关掉自己启动的进程。
 * 默认截图高度 1000 不代替这次测量。
 * 失败时进程非零退出，并写入 docs/verification/ui/2026-10-30-ui-ux-redo/shelf-1280x800.json。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { installFixtures } from './capture-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const outDir = `${root}/docs/verification/ui/2026-10-30-ui-ux-redo`;
const outFile = `${outDir}/shelf-1280x800.json`;
const VIEWPORT = { width: 1280, height: 800 };
const THEME = 'warm-light';
const LIBRARY_THEME = 'gallery';
const FALLBACK_PORTS = [1427, 1428, 1429];

const TITLES = [
  '围城',
  '活着',
  '三体',
  '边城',
  '白夜行记',
  '春潮',
  '山南',
  '北窗',
  '灯塔',
  '河岸',
  '远帆',
  '星图手记',
];

function shelfBook(index, reading) {
  return {
    id: `shelf-measure-${index}`,
    title: TITLES[index] ?? `书架测量 ${index}`,
    author: '测量',
    kind: 'text',
    extension: 'epub',
    localPath: `C:/Books/measure-${index}.epub`,
    progress: reading ? { index: 2, ratio: 0.35, total: 6, title: '第二章 灯' } : null,
    subjects: ['小说'],
    updatedAt: 1_790_700_000 - index,
  };
}

function fixtureArgs(count) {
  const books = Array.from({ length: count }, (_, index) => shelfBook(index, index === 0));
  return {
    theme: THEME,
    locale: 'zh-CN',
    books,
    draft: '',
    bookText: '',
    libraryTheme: LIBRARY_THEME,
    readerTheme: 'sepia',
    aiConfigured: false,
    onboardingDone: true,
  };
}

async function probeUrl(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!(response.ok || response.status < 500)) return 'foreign';
    const html = await response.text();
    return html.includes('<title>轻墨 LightInk</title>') ? 'lightink' : 'foreign';
  } catch {
    return 'down';
  }
}

function spawnViteDevServer(port) {
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[dev] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[dev] ${chunk}`));
  return child;
}

async function waitForLightink(child, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) return false;
    if (Date.now() > deadline) {
      child.kill();
      return false;
    }
    if ((await probeUrl(url)) === 'lightink') return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** 返回 { url, server }。server 非空时结束必须杀掉，且只杀这个子进程。 */
async function ensureDevServer() {
  const preview = process.env.LIGHTINK_PREVIEW_URL;
  if (preview !== undefined) {
    const status = await probeUrl(preview);
    if (status !== 'lightink') {
      throw new Error(`LIGHTINK_PREVIEW_URL=${preview} 探测结果为 ${status}（非 LightInk dev server）。`);
    }
    return { url: preview, server: null, reused: true };
  }
  const primary = 'http://localhost:1420';
  const probe = await probeUrl(primary);
  if (probe === 'lightink') return { url: primary, server: null, reused: true };
  if (probe === 'foreign') {
    console.log(`${primary} 被其他应用占用，将在备选端口自起本仓库 dev server …`);
  } else {
    console.log('dev server 未运行，正在启动 vite ...');
  }
  const candidates = probe === 'foreign' ? FALLBACK_PORTS : [1420, ...FALLBACK_PORTS];
  for (const port of candidates) {
    const url = `http://localhost:${port}`;
    if ((await probeUrl(url)) !== 'down') continue;
    const child = spawnViteDevServer(port);
    if (await waitForLightink(child, url, 300_000)) {
      console.log(`dev server 已就绪：${url}`);
      return { url, server: child, reused: false };
    }
  }
  throw new Error(
    `无法提供 LightInk dev server：1420 与备选端口 ${FALLBACK_PORTS.join('/')} 均不可用。`,
  );
}

function measureShelf() {
  const home = document.querySelector('.lightink-library-home');
  const wall = document.querySelector(
    '.lightink-library-home-books .lightink-library-cover-wall, .lightink-library-home-books .lightink-library-items',
  );
  const continueCard = document.querySelector('.lightink-library-continue');
  const covers = [
    ...document.querySelectorAll(
      '.lightink-library-home-books .lightink-library-item--cover .lightink-library-cover',
    ),
  ];
  const homeRect = home?.getBoundingClientRect() ?? null;
  const wallRect = wall?.getBoundingClientRect() ?? null;
  const frame =
    homeRect === null
      ? null
      : {
          top: Math.max(homeRect.top, 0),
          left: Math.max(homeRect.left, 0),
          bottom: Math.min(homeRect.bottom, window.innerHeight),
          right: Math.min(homeRect.right, window.innerWidth),
        };
  const coverBoxes = covers.map((cover) => {
    const rect = cover.getBoundingClientRect();
    const complete =
      frame !== null &&
      rect.width > 1 &&
      rect.height > 1 &&
      rect.top >= frame.top - 1 &&
      rect.left >= frame.left - 1 &&
      rect.bottom <= frame.bottom + 1 &&
      rect.right <= frame.right + 1;
    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      complete,
    };
  });
  const coverHeight = coverBoxes.reduce((max, box) => Math.max(max, box.height), 0);
  const visibleHomeBottom = frame === null ? 0 : frame.bottom;
  const blankBelowCoverArea =
    wallRect === null ? null : Math.max(0, visibleHomeBottom - wallRect.bottom);
  const continueVisible = continueCard !== null && continueCard.hidden !== true;
  const shell = document.querySelector('.lightink-library-home .lightink-library-item-shell');
  const shellWidth = shell === null ? null : getComputedStyle(shell).maxWidth;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    theme: document.documentElement.getAttribute('data-theme'),
    libraryTheme: document.querySelector('.lightink-library')?.getAttribute('data-library-theme') ?? null,
    display: document.documentElement.getAttribute('data-display'),
    continueVisible,
    continueText: continueVisible ? (continueCard.innerText ?? '').replace(/\s+/g, ' ').slice(0, 180) : '',
    home: homeRect,
    wall: wallRect,
    shellMaxWidth: shellWidth,
    coverHeight,
    blankBelowCoverArea,
    completeCovers: coverBoxes.filter((box) => box.complete).length,
    coverCount: coverBoxes.length,
    covers: coverBoxes.slice(0, 8),
  };
}

async function openShelf(browser, url, bookCount, externalImages) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15_000);
  page.on('request', (request) => {
    if (request.resourceType() !== 'image') return;
    const target = request.url();
    if (target.startsWith('data:') || target.startsWith('blob:')) return;
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      externalImages.push(target);
      return;
    }
    const local =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (!local) externalImages.push(target);
  });
  await page.addInitScript(installFixtures, fixtureArgs(bookCount));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const dialog = page.locator('.lightink-modal-dialog:visible').first();
  try {
    await dialog.waitFor({ timeout: 2_500 });
    const primary = dialog.locator('.lightink-modal-btn--primary');
    if ((await primary.count()) > 0) await primary.click({ timeout: 2_000 });
    else await dialog.locator('button').last().click({ timeout: 2_000 });
  } catch {
    /* 没有恢复对话框时直接进书架。 */
  }
  await page.waitForSelector(
    '.lightink-library:not([hidden]) .lightink-library-home-books .lightink-library-item--cover',
    { timeout: 30_000 },
  );
  await page.evaluate(async () => {
    document.querySelector('.lightink-library-home')?.scrollTo(0, 0);
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await page.waitForTimeout(200);
  const measured = await page.evaluate(measureShelf);
  await page.close();
  return measured;
}

function judge(few, many, externalImages) {
  const failures = [];
  if (few.innerWidth !== VIEWPORT.width || few.innerHeight !== VIEWPORT.height) {
    failures.push(`few viewport ${few.innerWidth}×${few.innerHeight}，要求 1280×800`);
  }
  if (many.innerWidth !== VIEWPORT.width || many.innerHeight !== VIEWPORT.height) {
    failures.push(`many viewport ${many.innerWidth}×${many.innerHeight}，要求 1280×800`);
  }
  if (few.theme !== THEME || many.theme !== THEME) {
    failures.push(`编辑器主题应为 ${THEME}，实测 few=${few.theme} many=${many.theme}`);
  }
  if (few.libraryTheme !== LIBRARY_THEME || many.libraryTheme !== LIBRARY_THEME) {
    failures.push(`书架主题应为 ${LIBRARY_THEME}，实测 few=${few.libraryTheme} many=${many.libraryTheme}`);
  }
  if (!few.continueVisible) failures.push('不超过 6 本且有在读时，继续阅读卡不可见');
  if (!(few.coverHeight > 0) || few.blankBelowCoverArea === null) {
    failures.push('少书场景没有可测量的封面区');
  } else if (!(few.blankBelowCoverArea < few.coverHeight)) {
    failures.push(
      `少书时封面区下方空白 ${few.blankBelowCoverArea.toFixed(1)}px，不小于一本封面高度 ${few.coverHeight.toFixed(1)}px`,
    );
  }
  if (many.completeCovers < 4) {
    failures.push(`不少于 12 本时首屏完整封面 ${many.completeCovers}，少于 4`);
  }
  if (externalImages.length > 0) {
    failures.push(`请求了网络图片：${externalImages.slice(0, 4).join(', ')}`);
  }
  return failures;
}

const report = {
  viewport: VIEWPORT,
  theme: THEME,
  libraryTheme: LIBRARY_THEME,
  passed: false,
  reusedServer: null,
  few: null,
  many: null,
  externalImages: [],
  failures: [],
};

let server = null;
let browser = null;
try {
  const dev = await ensureDevServer();
  server = dev.server;
  report.reusedServer = dev.reused;
  browser = await chromium.launch({ headless: true });
  report.few = await openShelf(browser, dev.url, 4, report.externalImages);
  report.many = await openShelf(browser, dev.url, 12, report.externalImages);
  report.failures = judge(report.few, report.many, report.externalImages);
  report.passed = report.failures.length === 0;
} catch (error) {
  report.failures.push(String(error).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 800));
  report.passed = false;
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(outFile);
  console.log(JSON.stringify({ passed: report.passed, failures: report.failures }, null, 2));
  if (server !== null) {
    server.kill();
    console.log('已关闭本次启动的 dev server');
  }
}

if (!report.passed) process.exitCode = 1;
