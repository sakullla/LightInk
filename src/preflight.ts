/**
 * 冷启动预置：在主包求值之前把持久化的主题写到 <html>，使首帧即用用户主题，
 * 避免大体量入口模块解析期间闪出内置默认主题（尤其深色主题用户）。
 *
 * 作为 index.html 中更早的 module script 加载；刻意保持零依赖、极简。
 * ThemeService 随后会再写入权威值（含自定义主题注入槽），此处只是首帧兜底。
 */
const BUILTIN_THEME_IDS = new Set(['warm-light', 'cool-light', 'dark', 'midnight']);
const DARK_PATTERN = /(?:^|[;{}\s])color-scheme\s*:\s*([^;}{]+)/i;

function resolveStartupTheme(): string | null {
  try {
    const saved = window.localStorage.getItem('lightink.theme');
    if (saved === null || saved === '') return null;
    if (BUILTIN_THEME_IDS.has(saved)) return saved;
    if (saved === 'custom') {
      // 自定义主题 CSS 尚未注入；仅据其 color-scheme 选深/浅内置令牌兜底首帧。
      const css = window.localStorage.getItem('lightink.theme.customCss') ?? '';
      const scheme = DARK_PATTERN.exec(css)?.[1]?.trim().split(/\s+/)[0]?.toLowerCase();
      return scheme === 'dark' ? 'dark' : 'warm-light';
    }
    return null;
  } catch {
    // localStorage 不可用（隐私模式等）：交给 ThemeService 走默认主题。
    return null;
  }
}

const startupTheme = resolveStartupTheme();
if (startupTheme !== null) {
  document.documentElement.setAttribute('data-theme', startupTheme);
}
