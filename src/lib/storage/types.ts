export type AssetKey = string;

export interface StoredAsset {
  key: AssetKey;
  size: number;
  contentType: string;
  etag?: string;
}

export interface PutAssetInput {
  key: AssetKey;
  body: Uint8Array;
  contentType: string;
}

export interface PutAssetFileInput {
  key: AssetKey;
  filePath: string;
  contentType: string;
}

export interface AssetStorage {
  put(input: PutAssetInput): Promise<StoredAsset>;
  putFile(input: PutAssetFileInput): Promise<StoredAsset>;
  delete(key: AssetKey): Promise<void>;
  exists(key: AssetKey): Promise<boolean>;
  downloadToFile(key: AssetKey, destinationPath: string): Promise<void>;
  getSignedReadUrl(key: AssetKey, expiresInSeconds: number, downloadFileName?: string): Promise<string>;
}
