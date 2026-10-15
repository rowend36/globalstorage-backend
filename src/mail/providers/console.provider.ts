import { Injectable } from '@nestjs/common';
import type { MailMessage, MailPort, MailSendResult } from '../mail.port';

@Injectable()
export class ConsoleMailProvider implements MailPort {
  // eslint-disable-next-line @typescript-eslint/require-await
  async send(message: MailMessage): Promise<MailSendResult> {
    console.info(
      {
        to: message.to,
        subject: message.subject,
        hasHtml: Boolean(message.html),
        hasText: Boolean(message.text),
        attachments: message.attachments?.map(({ filename }) => filename),
      },
      'mail',
    );
    console.info(
      [
        '',
        '========== OUTGOING MAIL ==========',
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        '',
        message.text ?? message.html ?? '(no body)',
        '',
        '===================================',
      ].join('\n'),
    );
    return {};
  }
}
