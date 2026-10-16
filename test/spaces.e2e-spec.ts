import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from './../src/app.module';
import { configureApplication } from '../src/bootstrap';

describe('spaces and keys (e2e)', () => {
  let app: INestApplication<App>;
  let tokens: { accessToken: string };
  let spaceId: string;

  const auth = (builder: request.Test) =>
    builder.set('authorization', `Bearer ${tokens.accessToken}`);

  beforeAll(async () => {
    process.env.DATABASE_DRIVER = 'sqlite';
    process.env.SQLITE_PATH = ':memory:';
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.REFRESH_HASH_PEPPER = 'test-refresh-pepper';
    process.env.AUTH_COOKIE_SECURE = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
    const orm = moduleFixture.get(MikroORM);
    await orm.schema.create();

    const register = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: 'storage@example.test', password: 'not-a-real-password' })
      .expect(201);
    tokens = { accessToken: register.body.accessToken };
  });

  it('creates a space with a default quota', async () => {
    const response = await auth(
      request(app.getHttpServer()).post('/v1/spaces').send({ name: 'Todo App' }),
    ).expect(201);
    expect(response.body).toMatchObject({
      name: 'Todo App',
      quotaBytes: 50 * 1024 * 1024,
      usedBytes: 0,
      state: 'active',
    });
    spaceId = response.body.id;
  });

  it('writes and reads values with nested keys', async () => {
    const put = await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('todos/123')}`)
        .set('content-type', 'application/json')
        .send(JSON.stringify({ title: 'Finish the todo app', completed: false })),
    ).expect(200);
    expect(put.body.key).toBe('todos/123');
    expect(typeof put.body.version).toBe('number');

    const get = await auth(
      request(app.getHttpServer()).get(
        `/v1/spaces/${spaceId}/keys/${encodeURIComponent('todos/123')}`,
      ),
    )
      .expect(200)
      .expect('content-type', /application\/json/);
    expect(JSON.parse(get.text)).toEqual({ title: 'Finish the todo app', completed: false });
    expect(get.headers['x-key-version']).toBe(String(put.body.version));

    // Unicode keys round-trip through NFC normalization.
    const decomposed = 'café/settings';
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent(decomposed)}`)
        .set('content-type', 'text/plain')
        .send('dark'),
    ).expect(200);
    const reread = await auth(
      request(app.getHttpServer()).get(
        `/v1/spaces/${spaceId}/keys/${encodeURIComponent('café/settings')}`,
      ),
    ).expect(200);
    expect(reread.text).toBe('dark');
  });

  it('enforces conditional writes', async () => {
    const first = await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('settings/theme')}`)
        .set('content-type', 'text/plain')
        .send('dark'),
    ).expect(200);
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('settings/theme')}`)
        .set('content-type', 'text/plain')
        .set('if-match', String(first.body.version))
        .send('light'),
    ).expect(200);
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('settings/theme')}`)
        .set('content-type', 'text/plain')
        .set('if-match', String(first.body.version))
        .send('stale'),
    ).expect(412);
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('settings/theme')}`)
        .set('content-type', 'text/plain')
        .set('if-none-match', '*')
        .send('x'),
    ).expect(412);
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('brand/new')}`)
        .set('content-type', 'text/plain')
        .set('if-none-match', '*')
        .send('created'),
    ).expect(200);
  });

  it('lists keys with prefix and pagination', async () => {
    for (const key of ['paged/1', 'paged/2', 'paged/3']) {
      await auth(
        request(app.getHttpServer())
          .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent(key)}`)
          .set('content-type', 'text/plain')
          .send(key),
      ).expect(200);
    }
    const page1 = await auth(
      request(app.getHttpServer()).get(`/v1/spaces/${spaceId}/keys?prefix=paged%2F&limit=2`),
    ).expect(200);
    expect(page1.body.keys.map((row: { key: string }) => row.key)).toEqual([
      'paged/1',
      'paged/2',
    ]);
    expect(typeof page1.body.nextCursor).toBe('string');
    const page2 = await auth(
      request(app.getHttpServer()).get(
        `/v1/spaces/${spaceId}/keys?prefix=paged%2F&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      ),
    ).expect(200);
    expect(page2.body.keys.map((row: { key: string }) => row.key)).toEqual(['paged/3']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('reports status and deletes keys', async () => {
    const status = await auth(
      request(app.getHttpServer()).get(`/v1/spaces/${spaceId}/status`),
    ).expect(200);
    expect(status.body.keyCount).toBeGreaterThan(0);
    expect(status.body.usedBytes).toBeGreaterThan(0);

    await auth(
      request(app.getHttpServer()).delete(
        `/v1/spaces/${spaceId}/keys/${encodeURIComponent('todos/123')}`,
      ),
    ).expect(200);
    await auth(
      request(app.getHttpServer()).get(
        `/v1/spaces/${spaceId}/keys/${encodeURIComponent('todos/123')}`,
      ),
    ).expect(404);
  });

  it('rejects invalid keys, oversized values, and quota breaches', async () => {
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('bad\u0007key')}`)
        .set('content-type', 'text/plain')
        .send('x'),
    ).expect(400);
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${spaceId}/keys/${encodeURIComponent('big')}`)
        .set('content-type', 'application/octet-stream')
        .send(Buffer.alloc(10 * 1024 * 1024 + 1)),
    ).expect(413);

    const tiny = await auth(
      request(app.getHttpServer()).post('/v1/spaces').send({ name: 'Tiny', quotaBytes: 100 }),
    ).expect(201);
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${tiny.body.id}/keys/${encodeURIComponent('a')}`)
        .set('content-type', 'application/octet-stream')
        .send(Buffer.alloc(60, 1)),
    ).expect(200);
    await auth(
      request(app.getHttpServer())
        .put(`/v1/spaces/${tiny.body.id}/keys/${encodeURIComponent('b')}`)
        .set('content-type', 'application/octet-stream')
        .send(Buffer.alloc(60, 2)),
    ).expect(403);
  });

  it('isolates spaces between users and manages space settings', async () => {
    const other = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: 'other@example.test', password: 'not-a-real-password' })
      .expect(201);
    const otherAuth = (builder: request.Test) =>
      builder.set('authorization', `Bearer ${other.body.accessToken}`);
    await otherAuth(
      request(app.getHttpServer()).get(`/v1/spaces/${spaceId}`),
    ).expect(404);

    const renamed = await auth(
      request(app.getHttpServer()).patch(`/v1/spaces/${spaceId}`).send({ name: 'Renamed' }),
    ).expect(200);
    expect(renamed.body.name).toBe('Renamed');
    const listed = await auth(request(app.getHttpServer()).get('/v1/spaces')).expect(200);
    expect(listed.body.map((space: { name: string }) => space.name)).toContain('Renamed');

    await auth(request(app.getHttpServer()).delete(`/v1/spaces/${spaceId}`)).expect(204);
    await auth(request(app.getHttpServer()).get(`/v1/spaces/${spaceId}`)).expect(404);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/v1/spaces').expect(401);
  });

  afterAll(async () => {
    await app.close();
  });
});
