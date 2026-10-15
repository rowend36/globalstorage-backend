import { join } from 'node:path';
import { EmailTemplateEngine } from './template-engine';

describe('EmailTemplateEngine', () => {
  it('renders a template inside the shared layout', () => {
    const engine = new EmailTemplateEngine(
      [join(__dirname, 'templates')],
      'https://app.example.test',
    );

    const html = engine.render('auth/password-reset.hbs', {
      name: 'Ada',
      token: 'abc123',
    });

    expect(html).toContain('Reset your password');
    expect(html).toContain(
      'https://app.example.test/reset-password?token=abc123',
    );
    expect(html).toContain('<main class="container">');
  });

  it('rejects missing and unsafe template paths', () => {
    const engine = new EmailTemplateEngine([join(__dirname, 'templates')]);

    expect(() => engine.render('missing.hbs')).toThrow(
      'Email template not found: missing.hbs',
    );
    expect(() => engine.render('../package.json')).toThrow(
      'Invalid email template: ../package.json',
    );
  });
});
