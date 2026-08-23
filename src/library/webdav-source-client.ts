import { invoke } from '@tauri-apps/api/core';

import type { OpdsCredential, OpdsFeed, OpdsSource, OpdsSourceInput } from './opds-client.js';

/** Named WebDAV library source; isomorphic with OpdsSource. */
export type WebDavSource = OpdsSource;

export type WebDavSourceInput = OpdsSourceInput;

export type WebDavCredential = OpdsCredential;

export interface WebDavSourceTestResult {
  readonly ok: boolean;
  readonly finalUrl: string;
  readonly server?: string;
}

export interface WebDavSourceClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: WebDavSourceClientInvoker = { invoke };

/** Typed facade for WebDAV library-source commands; secrets only cross IPC when entered. */
export class WebDavSourceClient {
  private readonly invoker: WebDavSourceClientInvoker;

  constructor(invoker: WebDavSourceClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  addSource(input: WebDavSourceInput): Promise<WebDavSource> {
    return this.invoker.invoke<WebDavSource>('webdav_source_add', { input });
  }

  listSources(): Promise<WebDavSource[]> {
    return this.invoker.invoke<WebDavSource[]>('webdav_source_list');
  }

  removeSource(sourceId: string): Promise<void> {
    return this.invoker.invoke<void>('webdav_source_remove', { sourceId });
  }

  test(input: WebDavSourceInput): Promise<WebDavSourceTestResult> {
    return this.invoker.invoke<WebDavSourceTestResult>('webdav_source_test', { input });
  }

  browse(sourceId: string, url?: string): Promise<OpdsFeed> {
    return this.invoker.invoke<OpdsFeed>('webdav_source_browse', { sourceId, url });
  }
}

export const webDavSourceClient = new WebDavSourceClient();
