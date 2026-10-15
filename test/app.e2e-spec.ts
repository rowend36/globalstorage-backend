import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MikroORM } from '@mikro-orm/core';
import * as argon2 from 'argon2';
import { UserSchema, TenantSchema, TenantMembershipSchema } from '../src/database/entities/schemas';

describe('authentication (e2e)', () => {
  let app: INestApplication<App>;
  let orm: MikroORM;
  const email = 'member@example.test';
  const password = 'not-a-real-password';

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
    orm = moduleFixture.get(MikroORM);
    await orm.schema.create();
    const em = orm.em.fork();
    // Mirror register(): a personal tenant with the 'none' MFA policy plus
    // a membership, so password login issues tokens without an MFA step.
    const tenant = em.create(TenantSchema, {
      slug: 'personal-e2e',
      name: 'Personal',
      path: 'personal-e2e',
      mfaPolicy: 'none',
      parent: null,
      deletedAt: null,
    });
    const user = em.create(UserSchema, { email, passwordHash: await argon2.hash(password) });
    em.create(TenantMembershipSchema, {
      user,
      tenant,
      includeDescendants: false,
      deletedAt: null,
    });
    await em.flush();
  });

  it('returns access and opaque refresh tokens in token mode', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(201);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rotates refresh tokens and revokes the session when a rotated token is replayed', async () => {
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(201);
    const refresh = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(201);
    expect(refresh.body.refreshToken).not.toBe(login.body.refreshToken);
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: refresh.body.refreshToken })
      .expect(401);
  });

  it('uses cookie-only delivery and requires CSRF for cookie refresh', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/v1/auth/login')
      .send({ email, password, cookies: true })
      .expect(201);
    expect(login.body).toEqual({ cookies: true });
    const cookies = login.headers['set-cookie'];
    const csrf = (Array.isArray(cookies) ? cookies : [])
      .find((cookie) => cookie.startsWith('csrf_token='))
      ?.split(';')[0]
      .split('=')[1];
    expect(csrf).toEqual(expect.any(String));
    await agent.post('/v1/auth/refresh').send({ cookies: true }).expect(403);
    await agent
      .post('/v1/auth/refresh')
      .set('x-csrf-token', csrf as string)
      .send({ cookies: true })
      .expect(201);
  });

  it('rejects stale access tokens after a membership/user authorization version change', async () => {
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(201);
    const em = orm.em.fork();
    const user = await em.findOneOrFail(UserSchema, { email });
    user.roleVersion += 1;
    em.persist(user);
    await em.flush();
    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('authorization', `Bearer ${login.body.accessToken}`)
      .expect(401);
  });

  it('logs out a valid session', async () => {
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('authorization', `Bearer ${login.body.accessToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });

  afterAll(async () => {
    await app.close();
  });
});
