import Database from 'better-sqlite3';
import { Migration20260828094424 } from './sqlite/Migration20260828094424';

describe('SQLite audit immutability migration', () => {
  it('rejects audit event updates and deletes', () => {
    const database = new Database(':memory:');
    database.exec(
      'create table audit_events (id text primary key, action text not null)',
    );
    database.exec('create table users (id text primary key)');

    const sql: string[] = [];
    const migration = new Migration20260828094424(
      {} as never,
      {} as never,
    );
    migration.addSql = ((statement: string) => sql.push(statement)) as never;
    migration.up();
    for (const statement of sql) database.exec(statement);

    database
      .prepare('insert into audit_events (id, action) values (?, ?)')
      .run('event-1', 'created');
    expect(() =>
      database
        .prepare('update audit_events set action = ? where id = ?')
        .run('changed', 'event-1'),
    ).toThrow('audit_events are immutable');
    expect(() =>
      database.prepare('delete from audit_events where id = ?').run('event-1'),
    ).toThrow('audit_events are immutable');
    expect(
      database.prepare('select count(*) as count from audit_events').get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});
