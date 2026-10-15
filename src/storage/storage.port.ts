export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface StorageObject {
  key: string;
  content: Uint8Array;
  contentType?: string;
  size: number;
  etag?: string;
  lastModified?: Date;
}

export interface StorageUrlOptions {
  expiresInSeconds?: number;
  downloadName?: string;
}

export interface StorageValidationOptions {
  maxBytes?: number;
  allowedContentTypes?: readonly string[];
}

export interface StoragePort {
  put(
    key: string,
    content: Uint8Array,
    contentType: string,
  ): Promise<StorageObject>;
  read(key: string): Promise<StorageObject>;
  delete(key: string): Promise<void>;
  getUrl(key: string, options?: StorageUrlOptions): Promise<string>;
  validateContent(
    content: Uint8Array,
    contentType: string,
    options?: StorageValidationOptions,
  ): void;
}
