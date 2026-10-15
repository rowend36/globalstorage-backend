import { Injectable } from '@nestjs/common';
import { generateSecret, verify } from 'otplib';
import { TemplatedMailService } from '../mail/templated-mail.service';

@Injectable()
export class MfaService {
  constructor(private readonly mail: TemplatedMailService) {}

  createTotpSecret(): string {
    return generateSecret();
  }

  async verifyTotp(token: string, secret: string): Promise<boolean> {
    return (await verify({ token, secret })).valid;
  }

  async sendEmailCode(email: string, code: string): Promise<void> {
    await this.mail.send({
      to: email,
      subject: 'Your verification code',
      template: 'auth/mfa-code.hbs',
      textTemplate: 'auth/mfa-code.txt.hbs',
      context: { code },
    });
  }
}
