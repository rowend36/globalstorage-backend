import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import nodemailer from 'nodemailer';
import { createClient } from 'redis';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfig } from '../config/configuration';

const HEALTH_CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((finish, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`Health check timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        finish(value);
      },
      (error) => {
        clearTimeout(timer);
        fail(error);
      },
    );
  });
}

@Injectable()
export class DependencyHealthIndicator {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async redis(key: string, provider: string, url?: string): Promise<HealthIndicatorResult> {
    if (provider !== 'redis') return this.indicator.check(key).up({ provider });
    if (!url) return this.indicator.check(key).down('Redis URL is not configured');

    const client = createClient({ url });
    try {
      await client.connect();
      await client.ping();
      return this.indicator.check(key).up({ provider });
    } catch (error) {
      return this.indicator.check(key).down({
        provider,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (client.isOpen) await client.quit();
    }
  }

  async storage(): Promise<HealthIndicatorResult> {
    const provider = this.config.get('storage.provider', { infer: true });
    if (provider === 'filesystem') {
      const directory = resolve(
        this.config.get('storage.directory', { infer: true }),
      );
      try {
        await mkdir(directory, { recursive: true });
        await access(directory, constants.R_OK | constants.W_OK);
        return this.indicator.check('storage').up({ provider });
      } catch (error) {
        return this.indicator.check('storage').down({
          provider,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const bucket = this.config.get('storage.bucket', { infer: true });
    const region = this.config.get('storage.region', { infer: true });
    if (!bucket || !region) {
      return this.indicator.check('storage').down({
        provider,
        message: 'S3 bucket and region are required',
      });
    }

    const client = new S3Client({ region });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return this.indicator.check('storage').up({ provider });
    } catch (error) {
      return this.indicator.check('storage').down({
        provider,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client.destroy();
    }
  }

  async mail(): Promise<HealthIndicatorResult> {
    const provider = this.config.get('mail.provider', { infer: true });
    const mail = this.config.get('mail', { infer: true });
    if (provider === 'console') return this.indicator.check('mail').up({ provider });
    if (provider === 'smtp') {
      if (!mail.smtpUrl)
        return this.indicator.check('mail').down({
          provider,
          message: 'Required configuration is missing for smtp',
        });
      const transport = nodemailer.createTransport(mail.smtpUrl);
      try {
        await withTimeout(transport.verify(), HEALTH_CHECK_TIMEOUT_MS);
        return this.indicator.check('mail').up({ provider });
      } catch (error) {
        return this.indicator.check('mail').down({
          provider,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        transport.close();
      }
    }
    if (provider === 'resend') {
      if (!mail.resendApiKey)
        return this.indicator.check('mail').down({
          provider,
          message: 'Required configuration is missing for resend',
        });
      try {
        const response = await withTimeout(
          fetch('https://api.resend.com/domains', {
            headers: { Authorization: `Bearer ${mail.resendApiKey}` },
          }),
          HEALTH_CHECK_TIMEOUT_MS,
        );
        if (!response.ok) {
          throw new Error(`Resend API returned ${response.status}`);
        }
        return this.indicator.check('mail').up({ provider });
      } catch (error) {
        return this.indicator.check('mail').down({
          provider,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.indicator.check('mail').down({
      provider,
      message: `Required configuration is missing for ${provider}`,
    });
  }
}
