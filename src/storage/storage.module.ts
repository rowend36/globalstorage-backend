import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import {
  FilesystemStorageProvider,
  S3StorageProvider,
} from './storage.providers';
import { STORAGE_PROVIDER, type StoragePort } from './storage.port';

@Global()
@Module({
  providers: [
    FilesystemStorageProvider,
    S3StorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [ConfigService, FilesystemStorageProvider, S3StorageProvider],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        filesystem: FilesystemStorageProvider,
        s3: S3StorageProvider,
      ): StoragePort => {
        const provider = config.get('storage.provider', { infer: true });
        if (provider === 'filesystem') return filesystem;
        if (provider === 's3') return s3;
        throw new Error(`Unsupported storage provider: ${provider}`);
      },
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
