import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppConfig } from '../config/configuration';

/** AES-256-GCM field encryption with versioned keys for safe rotation. */
@Injectable()
export class FieldEncryptionService {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentVersion: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const configured = config.get('security.fieldEncryptionKeys', { infer: true });
    if (configured) {
      for (const entry of configured.split(',').map((value) => value.trim())) {
        const separator = entry.indexOf(':');
        if (separator <= 0) throw new Error('FIELD_ENCRYPTION_KEYS must use version:base64-key entries');
        const version = entry.slice(0, separator);
        const key = Buffer.from(entry.slice(separator + 1), 'base64');
        if (key.length !== 32) throw new Error(`FIELD_ENCRYPTION_KEYS entry ${version} must be a base64 32-byte key`);
        this.keys.set(version, key);
      }
    } else {
      const legacy = String(config.get('security.fieldEncryptionKey', { infer: true }) ?? '');
      if (legacy) this.keys.set('v1', Buffer.from(legacy, 'base64'));
    }
    this.currentVersion =
      config.get('security.fieldEncryptionCurrentVersion', { infer: true }) ??
      [...this.keys.keys()].at(-1) ??
      'v1';
    if (this.keys.size && !this.keys.has(this.currentVersion))
      throw new Error(
        `FIELD_ENCRYPTION_CURRENT_VERSION is not present in FIELD_ENCRYPTION_KEYS: ${this.currentVersion}`,
      );
  }

  encrypt(value: string): string {
    const key = this.keys.get(this.currentVersion);
    if (!key) throw new Error('FIELD_ENCRYPTION_KEY or FIELD_ENCRYPTION_KEYS is required to encrypt fields');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [this.currentVersion, iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
  }

  decrypt(value: string): string {
    const parts = value.split('.');
    const version = parts.length === 4 ? parts.shift()! : 'v1';
    if (parts.length !== 3) throw new Error('Invalid encrypted field format');
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown field encryption key version: ${version}`);
    const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  isEncrypted(value: string): boolean {
    const parts = value.split('.');
    return parts.length === 3 || parts.length === 4;
  }

  isCurrent(value: string): boolean {
    return value.split('.').length === 4 && value.startsWith(`${this.currentVersion}.`);
  }
}
