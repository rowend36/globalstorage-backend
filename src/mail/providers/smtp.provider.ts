import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { AppConfig } from '../../config/configuration';
import type { MailMessage, MailPort, MailSendResult } from '../mail.port';

@Injectable()
export class SmtpMailProvider implements MailPort {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    const mail = this.config.get('mail', { infer: true });
    if (!mail.smtpUrl)
      throw new Error('SMTP_URL is required for the SMTP mail provider');
    const info = await nodemailer
      .createTransport(mail.smtpUrl)
      .sendMail({
        from: mail.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: message.attachments?.map((attachment) => ({
          ...attachment,
          cid: attachment.contentId,
        })),
      });
    return { messageId: info.messageId };
  }
}
