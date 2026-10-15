export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

export interface MailAttachment {
  filename?: string;
  content: string | Buffer;
  contentType?: string;
  contentId?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: readonly MailAttachment[];
}

export interface MailSendResult {
  messageId?: string;
}

export interface MailPort {
  send(message: MailMessage): Promise<MailSendResult>;
}
