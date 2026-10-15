export { MailModule } from './mail.module';
export {
  MAIL_PROVIDER,
  type MailAttachment,
  type MailMessage,
  type MailPort,
} from './mail.port';
export { EmailTemplateEngine } from './template-engine';
export { TemplatedMailService } from './templated-mail.service';
export { ConsoleMailProvider } from './providers/console.provider';
export { SmtpMailProvider } from './providers/smtp.provider';
export { ResendMailProvider } from './providers/resend.provider';
