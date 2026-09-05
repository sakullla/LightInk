import { classifyLibraryKind, type LibraryBookKind } from './library-kind.js';
import type { LibraryGroup, LibraryItem } from './library-client.js';
import type { LibraryProgress } from './library-progress.js';

export type SmartGroupRule =
  | { readonly type: 'progress'; readonly value: 'in-progress' | 'unread' }
  | { readonly type: 'kind'; readonly value: LibraryBookKind }
  | { readonly type: 'source'; readonly value: string }
  | { readonly type: 'format'; readonly value: string }
  | { readonly type: 'author' | 'series'; readonly value: string };

export interface SmartGroupDefinition {
  readonly id: string;
  readonly nameKey: string;
  readonly rule: SmartGroupRule;
  readonly sortOrder: number;
}

export type SmartGroupTypeId = 'fixed' | 'format' | 'author' | 'series';

export const SMART_GROUP_TYPE_ORDER: readonly SmartGroupTypeId[] = [
  'fixed',
  'format',
  'author',
  'series',
];

export function isPerSourceSmartGroup(
  group: Pick<SmartGroupDefinition, 'id' | 'rule'>,
): boolean {
  return (
    group.id.startsWith('smart:source:') ||
    (group.rule.type === 'source' && group.rule.value.startsWith('id:'))
  );
}

export function smartGroupTypeId(group: SmartGroupDefinition): SmartGroupTypeId {
  switch (group.rule.type) {
    case 'format':
      return 'format';
    case 'author':
      return 'author';
    case 'series':
      return 'series';
    default:
      return 'fixed';
  }
}

export const SMART_GROUP_DEFINITIONS: readonly SmartGroupDefinition[] = [
  { id: 'smart:in-progress', nameKey: 'inReading', rule: { type: 'progress', value: 'in-progress' }, sortOrder: 0 },
  { id: 'smart:unread', nameKey: 'unread', rule: { type: 'progress', value: 'unread' }, sortOrder: 1 },
  { id: 'smart:text', nameKey: 'textBooks', rule: { type: 'kind', value: 'text' }, sortOrder: 2 },
  { id: 'smart:comic', nameKey: 'comics', rule: { type: 'kind', value: 'comic' }, sortOrder: 3 },
  { id: 'smart:managed', nameKey: 'managedBooks', rule: { type: 'source', value: 'managed' }, sortOrder: 4 },
  { id: 'smart:remote', nameKey: 'remoteBooks', rule: { type: 'source', value: 'remote' }, sortOrder: 5 },
  { id: 'smart:epub', nameKey: 'epubBooks', rule: { type: 'format', value: 'epub' }, sortOrder: 6 },
  { id: 'smart:pdf', nameKey: 'pdfBooks', rule: { type: 'format', value: 'pdf' }, sortOrder: 7 },
];

function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

function sourceValue(item: LibraryItem): 'managed' | 'external' | 'remote' {
  if (item.sourceKind === 'managed' || item.blobHash != null) return 'managed';
  if (
    item.sourceKind === 'opds' ||
    item.sourceKind === 'webdav' ||
    item.sourceKind === 'remote' ||
    item.availability === 'remote'
  ) {
    return 'remote';
  }
  return 'external';
}

export function smartGroupMatches(
  item: LibraryItem,
  rule: SmartGroupRule,
  progress: LibraryProgress | null,
): boolean {
  switch (rule.type) {
    case 'progress':
      return rule.value === 'in-progress'
        ? progress?.status === 'in-progress'
        : progress?.status === 'not-started';
    case 'kind':
      return classifyLibraryKind(item) === rule.value;
    case 'source':
      return rule.value.startsWith('id:')
        ? item.sourceId === rule.value.slice(3)
        : sourceValue(item) === rule.value;
    case 'format':
      return clean(item.extension).toLowerCase().replace(/^\./, '') === rule.value;
    case 'author':
      return Array.isArray(item.authors) && item.authors.some((author) => clean(author) === rule.value);
    case 'series':
      return clean(item.series) === rule.value;
  }
}

export function dynamicSourceAndFormatGroups(items: readonly LibraryItem[]): SmartGroupDefinition[] {
  const result: SmartGroupDefinition[] = [];
  const seenFormats = new Set<string>();
  for (const item of items) {
    const format = clean(item.extension).toLowerCase().replace(/^\./, '');
    if (format !== '' && !seenFormats.has(format)) {
      seenFormats.add(format);
      result.push({
        id: `smart:format:${format}`,
        nameKey: format.toUpperCase(),
        rule: { type: 'format', value: format },
        sortOrder: 30,
      });
    }
  }
  return result;
}

export function dynamicAuthorAndSeriesGroups(items: readonly LibraryItem[]): SmartGroupDefinition[] {
  const counts = new Map<string, { readonly kind: 'author' | 'series'; count: number }>();
  for (const item of items) {
    const authors = new Set(
      (Array.isArray(item.authors) ? item.authors : []).map(clean).filter(Boolean),
    );
    for (const author of authors) {
      const key = `author:${author}`;
      const current = counts.get(key);
      counts.set(key, { kind: 'author', count: (current?.count ?? 0) + 1 });
    }
    const series = clean(item.series);
    if (series !== '') {
      const key = `series:${series}`;
      const current = counts.get(key);
      counts.set(key, { kind: 'series', count: (current?.count ?? 0) + 1 });
    }
  }
  const result: SmartGroupDefinition[] = [];
  for (const [key, value] of counts) {
    if (value.count < 2) continue;
    const [, ...parts] = key.split(':');
    const label = parts.join(':');
    result.push({
      id: `smart:${key}`,
      nameKey: value.kind,
      rule: { type: value.kind, value: label },
      sortOrder: value.kind === 'author' ? 100 : 200,
    });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

export function smartGroupFromRecord(group: LibraryGroup): SmartGroupDefinition | null {
  if (group.kind !== 'smart' || group.rule === undefined) return null;
  const rule = group.rule as Partial<SmartGroupRule>;
  if (
    (rule.type !== 'progress' &&
      rule.type !== 'kind' &&
      rule.type !== 'source' &&
      rule.type !== 'format' &&
      rule.type !== 'author' &&
      rule.type !== 'series') ||
    typeof rule.value !== 'string'
  ) {
    return null;
  }
  const definition: SmartGroupDefinition = {
    id: group.id,
    nameKey: rule.type === 'author' || rule.type === 'series' ? rule.type : group.name,
    rule: rule as SmartGroupRule,
    sortOrder: group.sortOrder,
  };
  if (isPerSourceSmartGroup(definition)) return null;
  return definition;
}
