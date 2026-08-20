import { invoke } from '@tauri-apps/api/core';

/** OPDS 1.x link returned by the native parser. */
export interface OpdsLink {
  readonly href: string;
  readonly rel: string;
  readonly mediaType?: string;
  readonly title?: string;
  readonly size?: number;
  readonly extension?: string;
  readonly acquisition: boolean;
}

export interface OpdsGroup {
  readonly title?: string;
  readonly publications?: readonly OpdsEntry[];
  readonly navigation: readonly OpdsEntry[];
}

export interface OpdsEntry {
  readonly id: string;
  readonly itemId?: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly updated?: string;
  readonly summary?: string;
  readonly coverUrl?: string;
  readonly links: readonly OpdsLink[];
  readonly kind?: 'publication' | 'navigation';
  readonly navigationUrl?: string;
  readonly subjects?: readonly string[];
  readonly series?: string;
}

export interface OpdsFeed {
  readonly id?: string;
  readonly title: string;
  readonly updated?: string;
  readonly entries: readonly OpdsEntry[];
  readonly links: readonly OpdsLink[];
  readonly nextUrl?: string;
  readonly previousUrl?: string;
  readonly searchTemplate?: string;
  readonly sourceUrl: string;
  readonly format?: 'opds1' | 'opds2';
  readonly groups?: readonly OpdsGroup[];
}

export interface OpdsSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly credentialRef?: string;
  readonly allowHttp: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OpdsCredential {
  readonly kind: 'basic' | 'bearer';
  readonly username?: string;
  readonly password?: string;
  readonly token?: string;
}

export interface OpdsSourceInput {
  readonly id?: string;
  readonly title: string;
  readonly url: string;
  readonly allowHttp?: boolean;
  readonly credentialRef?: string;
  readonly credential?: OpdsCredential;
  readonly clearCredential?: boolean;
}

export interface OpdsClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Never forward a catalog credential to an acquisition on another origin. */
export function credentialRefForResource(
  source: OpdsSource | undefined,
  resourceUrl: string,
): string | undefined {
  if (source?.credentialRef === undefined) return undefined;
  try {
    const sourceUrl = new URL(source.url);
    const targetUrl = new URL(resourceUrl, sourceUrl);
    return sourceUrl.origin === targetUrl.origin ? source.credentialRef : undefined;
  } catch {
    return undefined;
  }
}

const nativeInvoker: OpdsClientInvoker = { invoke };

/** Small typed facade for OPDS commands; credentials are handed to Rust only. */
export class OpdsClient {
  private readonly invoker: OpdsClientInvoker;

  constructor(invoker: OpdsClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  addSource(input: OpdsSourceInput): Promise<OpdsSource> {
    return this.invoker.invoke<OpdsSource>('opds_add_source', { source: input });
  }

  listSources(): Promise<OpdsSource[]> {
    return this.invoker.invoke<OpdsSource[]>('opds_list_sources');
  }

  removeSource(sourceId: string): Promise<void> {
    return this.invoker.invoke<void>('opds_remove_source', { sourceId });
  }

  browse(sourceId: string, url?: string): Promise<OpdsFeed> {
    return this.invoker.invoke<OpdsFeed>('opds_browse', { sourceId, url });
  }

  search(sourceId: string, query: string): Promise<OpdsFeed> {
    return this.invoker.invoke<OpdsFeed>('opds_search', { sourceId, query });
  }
}

export const opdsClient = new OpdsClient();
