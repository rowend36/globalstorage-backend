import Database from 'better-sqlite3';
import { createKeyv } from 'cacheable';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { MikroORM } from '@mikro-orm/core';
import { ConsoleMailProvider } from '../mail/providers/console.provider';
import { MemoryQueueProvider } from '../infrastructure/queue/memory.provider';
import { MemoryRateLimitProvider } from '../infrastructure/rate-limit/memory.provider';
import { AuditEventSchema } from '../database/entities/schemas';

describe('local provider integrations', () => {
  it('enforces audit immutability in an in-memory SQLite database', async () => {
    const database = new Database(':memory:');
    database.exec(`
      create table audit_events (id text primary key, action text not null);
      create trigger audit_events_immutable_update
        before update on audit_events
        for each row begin
          select raise(abort, 'audit_events are immutable');
        end;
      create trigger audit_events_immutable_delete
        before delete on audit_events
        for each row begin
          select raise(abort, 'audit_events are immutable');
        end;
    `);
    database.prepare('insert into audit_events values (?, ?)').run('event-1', 'created');

    expect(() => database.prepare('update audit_events set action = ?').run('changed')).toThrow(
      'audit_events are immutable',
    );
    expect(() => database.prepare('delete from audit_events').run()).toThrow(
      'audit_events are immutable',
    );
    database.close();
  });

  it('supports memory cache operations', async () => {
    const cache = createKeyv({ ttl: 60_000 });
    await cache.set('integration-key', { value: 'cached' });
    await expect(cache.get('integration-key')).resolves.toEqual({ value: 'cached' });
    await cache.delete('integration-key');
    await expect(cache.get('integration-key')).resolves.toBeUndefined();
  });

  it('supports memory queue and rate-limit operations', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const queue = new MemoryQueueProvider();
    await expect(queue.add('integration.job', { id: 1 })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      { name: 'integration.job', payload: { id: 1 } },
      'inline queue job',
    );
    log.mockRestore();

    const rateLimit = new MemoryRateLimitProvider();
    await expect(rateLimit.increment('integration-key', 60_000, 1, 60_000, 'test')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    await expect(rateLimit.increment('integration-key', 60_000, 1, 60_000, 'test')).resolves.toMatchObject({
      totalHits: 2,
      isBlocked: true,
    });
  });

  it('routes mail through the console provider without external delivery', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    await new ConsoleMailProvider().send({
      to: 'test@example.test',
      subject: 'Integration test',
      text: 'test body with reset link',
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'test@example.test', subject: 'Integration test' }),
      'mail',
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('test body with reset link'),
    );
    log.mockRestore();
  });

  it('can initialize MikroORM with the SQLite driver in memory', async () => {
    const orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [AuditEventSchema],
    });
    await expect(orm.em.getConnection().execute('select 1 as ok')).resolves.toEqual([{ ok: 1 }]);
    await orm.close(true);
  });
});
