import { invoke } from '@tauri-apps/api/core';

export type SyncAuthType = 'basic' | 'bearer';

export interface SyncCredential {
  readonly kind: SyncAuthType;
  readonly username?: string;
  readonly password?: string;
  readonly token?: string;
}

export interface SyncProfile {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly authType: SyncAuthType;
  readonly allowHttp: boolean;
  readonly needsCredential: boolean;
  readonly updatedAt: number;
}

export interface SyncProfileInput {
  readonly id?: string;
  readonly name: string;
  readonly url: string;
  readonly authType: SyncAuthType;
  readonly allowHttp?: boolean;
  readonly credential?: SyncCredential;
  readonly clearCredential?: boolean;
}

export interface WebDavCapability {
  readonly reachable: boolean;
  readonly supportsPropfind: boolean;
  readonly supportsMkcol: boolean;
  readonly supportsMove: boolean;
  readonly supportsConditionalPut: boolean;
  readonly finalUrl: string;
  readonly server?: string;
}

export interface SyncCredentialResult {
  readonly credentialRef: string;
  readonly persisted: boolean;
  readonly needsCredential: boolean;
}

export interface SyncClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: SyncClientInvoker = { invoke };

/** Typed frontend boundary for WebDAV configuration. Secrets only cross IPC when entered. */
export class WebDavClient {
  private readonly invoker: SyncClientInvoker;

  constructor(invoker: SyncClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  getProfile(): Promise<SyncProfile | null> {
    return this.invoker.invoke<SyncProfile | null>('sync_get_profile');
  }

  saveProfile(input: SyncProfileInput): Promise<SyncProfile> {
    return this.invoker.invoke<SyncProfile>('sync_save_profile', { input });
  }

  testProfile(input: SyncProfileInput): Promise<WebDavCapability> {
    return this.invoker.invoke<WebDavCapability>('sync_test_profile', { input });
  }

  forgetProfile(): Promise<void> {
    return this.invoker.invoke<void>('sync_forget_profile');
  }

  storeCredential(profileId: string, credential: SyncCredential): Promise<SyncCredentialResult> {
    return this.invoker.invoke<SyncCredentialResult>('sync_store_credential', {
      profileId,
      credential,
    });
  }
}

export const webDavClient = new WebDavClient();
