import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly orm: MikroORM,
  ) {}

  ping(key: string, timeoutMs = 1_500): Promise<HealthIndicatorResult> {
    return this.withTimeout(this.orm.em.getConnection().execute('select 1'), timeoutMs)
      .then(() => this.indicator.check(key).up({ driver: this.orm.driver.constructor.name }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return this.indicator.check(key).down(message);
      });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout of ${ms}ms exceeded`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}