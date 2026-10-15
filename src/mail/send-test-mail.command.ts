import { Command, CommandRunner, Option } from 'nest-commander';
import { TemplatedMailService } from './templated-mail.service';

interface SendTestMailOptions {
  to: string;
  subject?: string;
  message?: string;
}

@Command({
  name: 'send-test-mail',
  description: 'Send a test email to verify mail delivery',
})
export class SendTestMailCommand extends CommandRunner {
  constructor(private readonly mail: TemplatedMailService) {
    super();
  }

  async run(
    _passedParams: string[],
    options: SendTestMailOptions,
  ): Promise<void> {
    const to = options.to.trim().toLowerCase();
    if (!to.includes('@')) throw new Error('A valid email address is required');

    await this.mail.send({
      to,
      subject: options.subject?.trim() || 'Test email from globalstorage-backend',
      template: 'test.hbs',
      textTemplate: 'test.txt.hbs',
      context: { message: options.message?.trim() || '' },
    });

    console.log(`Test email accepted for ${to}`);
  }

  @Option({ flags: '-t, --to <email>', description: 'Recipient email address', required: true })
  parseTo(value: string): string {
    return value;
  }

  @Option({ flags: '-s, --subject <subject>', description: 'Email subject' })
  parseSubject(value: string): string {
    return value;
  }

  @Option({ flags: '-m, --message <message>', description: 'Optional body message' })
  parseMessage(value: string): string {
    return value;
  }
}