import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';

type LanguageModule = { readonly default: LanguageFn };
type LanguageLoader = () => Promise<LanguageModule>;

/**
 * Keep the picker intentionally focused on common document and programming
 * languages. Literal imports let Vite emit one on-demand chunk per grammar.
 */
const LANGUAGE_LOADERS = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  http: () => import('highlight.js/lib/languages/http'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  julia: () => import('highlight.js/lib/languages/julia'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  nim: () => import('highlight.js/lib/languages/nim'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  shell: () => import('highlight.js/lib/languages/shell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
} satisfies Record<string, LanguageLoader>;

export type HighlightLanguage = keyof typeof LANGUAGE_LOADERS;

export const SUPPORTED_HIGHLIGHT_LANGUAGES: readonly HighlightLanguage[] = (
  Object.keys(LANGUAGE_LOADERS) as HighlightLanguage[]
).sort((left, right) => left.localeCompare(right));

const LANGUAGE_ALIASES: Readonly<Record<string, HighlightLanguage>> = {
  atom: 'xml',
  'c#': 'csharp',
  'c++': 'cpp',
  cjs: 'javascript',
  clj: 'clojure',
  console: 'shell',
  cs: 'csharp',
  cts: 'typescript',
  docker: 'dockerfile',
  edn: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  golang: 'go',
  gql: 'graphql',
  h: 'c',
  'h++': 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hs: 'haskell',
  htm: 'xml',
  html: 'xml',
  https: 'http',
  hxx: 'cpp',
  ipython: 'python',
  irb: 'ruby',
  jl: 'julia',
  js: 'javascript',
  jsonc: 'json',
  jsp: 'java',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  mak: 'makefile',
  make: 'makefile',
  md: 'markdown',
  mk: 'makefile',
  mkd: 'markdown',
  mkdown: 'markdown',
  mjs: 'javascript',
  mm: 'objectivec',
  mts: 'typescript',
  nginxconf: 'nginx',
  nimrod: 'nim',
  'obj-c': 'objectivec',
  'obj-c++': 'objectivec',
  objc: 'objectivec',
  'objective-c++': 'objectivec',
  patch: 'diff',
  pl: 'perl',
  plist: 'xml',
  pluto: 'lua',
  pm: 'perl',
  proto: 'protobuf',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  rss: 'xml',
  sh: 'bash',
  shellsession: 'shell',
  svg: 'xml',
  svelte: 'xml',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  wsf: 'xml',
  xhtml: 'xml',
  xjb: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yml: 'yaml',
  zsh: 'bash',
};

const LANGUAGE_DEPENDENCIES: Partial<
  Readonly<Record<HighlightLanguage, readonly HighlightLanguage[]>>
> = {
  dart: ['markdown'],
  dockerfile: ['bash'],
  markdown: ['xml'],
  shell: ['bash'],
  yaml: ['ruby'],
};

const languagePromises = new Map<HighlightLanguage, Promise<boolean>>();

export function resolveHighlightLanguage(tag: string): HighlightLanguage | null {
  const normalized = tag.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANGUAGE_LOADERS, normalized)) {
    return normalized as HighlightLanguage;
  }
  return LANGUAGE_ALIASES[normalized] ?? null;
}

/**
 * True when the picker name or any alias that resolves to it contains `query`.
 * `query` must already be trimmed and lowercased.
 */
export function languageMatchesQuery(name: string, query: string): boolean {
  if (name.toLowerCase().includes(query)) {
    return true;
  }
  for (const [alias, canonical] of Object.entries(LANGUAGE_ALIASES)) {
    if (canonical === name && alias.includes(query)) {
      return true;
    }
  }
  return false;
}

export function isHighlightLanguageLoaded(language: HighlightLanguage): boolean {
  return hljs.getLanguage(language) !== undefined;
}

/** Load and register a grammar once, including the dependencies declared by highlight.js. */
export async function ensureHighlightLanguage(
  language: HighlightLanguage,
): Promise<boolean> {
  if (isHighlightLanguageLoaded(language)) {
    return true;
  }
  const existing = languagePromises.get(language);
  if (existing !== undefined) {
    return existing;
  }

  const pending = (async (): Promise<boolean> => {
    for (const dependency of LANGUAGE_DEPENDENCIES[language] ?? []) {
      if (!(await ensureHighlightLanguage(dependency))) {
        return false;
      }
    }
    const module = await LANGUAGE_LOADERS[language]();
    if (!isHighlightLanguageLoaded(language)) {
      hljs.registerLanguage(language, module.default);
    }
    return isHighlightLanguageLoaded(language);
  })().catch(() => false);
  languagePromises.set(language, pending);

  const loaded = await pending;
  if (!loaded) {
    languagePromises.delete(language);
  }
  return loaded;
}

export { hljs as highlightEngine };
