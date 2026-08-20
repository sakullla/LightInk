import { invoke } from '@tauri-apps/api/core';

export interface ManagedDocument {
  readonly id: string;
  readonly contentHash: string;
  readonly title: string;
  readonly localPath?: string;
  readonly availability: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ManagedAsset {
  readonly hash: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mediaType?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DocumentVersion {
  readonly id: string;
  readonly documentId: string;
  readonly blobHash: string;
  readonly size: number;
  readonly deviceId?: string;
  readonly createdAt: number;
  readonly isCurrent: boolean;
}

export interface DocumentDraft {
  readonly id: string;
  readonly documentId?: string;
  readonly blobHash: string;
  readonly title?: string;
  readonly deviceId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface JoinDocumentResult {
  readonly document: ManagedDocument;
  /** 本机运行时受管副本路径；不会出现在同步快照。 */
  readonly managedPath: string;
  readonly content: string;
  readonly copiedAssets: readonly ManagedAsset[];
  readonly warnings: readonly string[];
}

export interface DocumentClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: DocumentClientInvoker = { invoke };

export class DocumentClient {
  private readonly invoker: DocumentClientInvoker;

  constructor(invoker: DocumentClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  join(path: string): Promise<JoinDocumentResult> {
    return this.invoker.invoke<JoinDocumentResult>('managed_document_join', { path });
  }

  read(documentId: string): Promise<string> {
    return this.invoker.invoke<string>('managed_document_read', { documentId });
  }

  list(): Promise<ManagedDocument[]> {
    return this.invoker.invoke<ManagedDocument[]>('managed_document_list');
  }

  createVersion(documentId: string, content: string, deviceId?: string): Promise<DocumentVersion> {
    return this.invoker.invoke<DocumentVersion>('managed_document_create_version', {
      documentId,
      content,
      deviceId,
    });
  }

  listVersions(documentId: string): Promise<DocumentVersion[]> {
    return this.invoker.invoke<DocumentVersion[]>('managed_document_list_versions', { documentId });
  }

  readVersion(documentId: string, versionId: string): Promise<string> {
    return this.invoker.invoke<string>('managed_document_read_version', {
      documentId,
      versionId,
    });
  }

  saveDraft(
    documentId: string | undefined,
    title: string | undefined,
    deviceId: string,
    content: string,
    draftId?: string,
  ): Promise<DocumentDraft> {
    return this.invoker.invoke<DocumentDraft>('managed_document_save_draft', {
      draftId,
      documentId,
      title,
      deviceId,
      content,
    });
  }

  listDrafts(): Promise<DocumentDraft[]> {
    return this.invoker.invoke<DocumentDraft[]>('managed_document_list_drafts');
  }

  readDraft(draftId: string): Promise<string> {
    return this.invoker.invoke<string>('managed_document_read_draft', { draftId });
  }

  deleteDraft(draftId: string): Promise<void> {
    return this.invoker.invoke<void>('managed_document_delete_draft', { draftId });
  }
}

export const documentClient = new DocumentClient();
