import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend, type CreateEmailOptions } from 'resend';
import { AppConfig } from '../../config/configuration';
import type { MailMessage, MailPort, MailSendResult } from '../mail.port';

@Injectable()
export class ResendMailProvider implements MailPort {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    const mail = this.config.get('mail', { infer: true });
    if (!mail.resendApiKey)
      throw new Error(
        'RESEND_API_KEY is required for the Resend mail provider',
      );
    const result = await new Resend(mail.resendApiKey).emails.send({
      from: mail.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map((attachment) => ({
        ...attachment,
        contentId: attachment.contentId,
      })),
    } as CreateEmailOptions);
    return { messageId: result?.data?.id };
  }
}
