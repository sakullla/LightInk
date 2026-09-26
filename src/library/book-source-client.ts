import { invoke } from '@tauri-apps/api/core';

/** 书源规则的正则可选组；与 Rust `book_source::BookSourceRule` 同构。 */
export interface BookSourceHeader {
  readonly name: string;
  readonly value: string;
}

export interface BookSourceSearchRule {
  readonly url: string;
  readonly item: string;
  readonly title: string;
  readonly author?: string;
  readonly link?: string;
  readonly cover?: string;
  readonly nextPage?: string;
}

export interface BookSourceTocRule {
  readonly url?: string;
  readonly item: string;
  readonly title: string;
  readonly link?: string;
  readonly nextPage?: string;
}

export interface BookSourceContentRule {
  readonly text: string;
  readonly cleanup?: readonly string[];
  readonly nextPage?: string;
}

export interface BookSourceRule {
  readonly version: number;
  readonly baseUrl: string;
  readonly charset?: string;
  readonly rateLimitMs?: number;
  readonly headers?: readonly BookSourceHeader[];
  readonly search: BookSourceSearchRule;
  readonly toc?: BookSourceTocRule;
  readonly content?: BookSourceContentRule;
}

export interface BookSource {
  readonly id: string;
  readonly title: string;
  readonly rule: BookSourceRule;
  readonly enabled: boolean;
  readonly allowHttp: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BookSourceInput {
  readonly id?: string;
  readonly title: string;
  readonly allowHttp?: boolean;
  readonly rule: unknown;
}

export interface BookSourceIssue {
  readonly field: string;
  readonly message: string;
}

export interface BookSourceCheck {
  readonly ok: boolean;
  readonly issues: readonly BookSourceIssue[];
}

export interface BookSourceBuiltin {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly license: string;
  readonly rule: BookSourceRule;
}

export interface BookSourceSearchResult {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly title: string;
  readonly author?: string;
  readonly url: string;
  readonly coverUrl?: string;
}

export interface BookSourceChapter {
  readonly title: string;
  readonly url: string;
}

export interface BookSourceClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: BookSourceClientInvoker = { invoke };

/**
 * 通用书源命令的 typed facade。规则以 JSON 结构跨 IPC；网络访问只在 Rust 侧发生，
 * 自检可在无网络时给出字段级失败原因。
 */
export class BookSourceClient {
  private readonly invoker: BookSourceClientInvoker;

  constructor(invoker: BookSourceClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  listSources(): Promise<BookSource[]> {
    return this.invoker.invoke<BookSource[]>('book_source_list');
  }

  upsertSource(input: BookSourceInput): Promise<BookSource> {
    return this.invoker.invoke<BookSource>('book_source_upsert', { input });
  }

  removeSource(sourceId: string): Promise<void> {
    return this.invoker.invoke<void>('book_source_remove', { sourceId });
  }

  setSourceEnabled(sourceId: string, enabled: boolean): Promise<BookSource> {
    return this.invoker.invoke<BookSource>('book_source_set_enabled', { sourceId, enabled });
  }

  importSources(json: string): Promise<BookSource[]> {
    return this.invoker.invoke<BookSource[]>('book_source_import', { json });
  }

  exportSources(sourceIds?: readonly string[]): Promise<string> {
    return this.invoker.invoke<string>(
      'book_source_export',
      sourceIds === undefined ? undefined : { sourceIds: [...sourceIds] },
    );
  }

  selfCheck(rule: unknown, allowHttp: boolean): Promise<BookSourceCheck> {
    return this.invoker.invoke<BookSourceCheck>('book_source_self_check', { rule, allowHttp });
  }

  builtins(): Promise<BookSourceBuiltin[]> {
    return this.invoker.invoke<BookSourceBuiltin[]>('book_source_builtins');
  }

  fetchPage(
    sourceId: string,
    input: { readonly query?: string; readonly url?: string },
  ): Promise<{ finalUrl: string; status: number; length: number; snippet: string }> {
    return this.invoker.invoke('book_source_fetch', { sourceId, ...input });
  }

  search(sourceId: string, query: string): Promise<BookSourceSearchResult[]> {
    return this.invoker.invoke<BookSourceSearchResult[]>('book_source_search', {
      sourceId,
      query,
    });
  }

  /** 目录/正文读取供下载管线（R8）复用；本任务先打通引擎面。 */
  chapters(sourceId: string, bookUrl: string): Promise<BookSourceChapter[]> {
    return this.invoker.invoke<BookSourceChapter[]>('book_source_chapters', {
      sourceId,
      bookUrl,
    });
  }

  chapterText(sourceId: string, chapterUrl: string): Promise<string> {
    return this.invoker.invoke<string>('book_source_chapter_text', {
      sourceId,
      chapterUrl,
    });
  }
}

export const bookSourceClient = new BookSourceClient();
