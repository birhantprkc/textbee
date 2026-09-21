import { ISendMailOptions, MailerService } from '@nest-modules/mailer'
import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { layoutContext, renderTemplate } from './render-template'
import { SentEmail, SentEmailDocument } from './schemas/sent-email.schema'

export interface MailLogOptions {
  userId?: Types.ObjectId | string
  category: string
  type?: string
  meta?: Record<string, any>
  redactContextKeys?: string[]
}

type SendResult = { sentAt: Date; info?: any; error?: string }

/** One bare address, so a display name cannot leak through the mask. */
const BARE_ADDRESS = /^[^\s<>@,"]+@[^\s<>@,"]+$/

/** Keeps recipient addresses out of the logs while staying traceable. */
const redactRecipient = (to: ISendMailOptions['to']): string => {
  if (Array.isArray(to)) {
    return to.length === 1 ? redactRecipient(to[0]) : 'redacted'
  }
  const address = typeof to === 'string' ? to : to?.address
  if (!address) {
    return 'unknown recipient'
  }
  const trimmed = address.trim()
  if (!BARE_ADDRESS.test(trimmed)) {
    return 'redacted'
  }
  const [local, domain] = trimmed.split('@')
  return `${local.slice(0, 2)}***@${domain}`
}

const toAddressList = (value: ISendMailOptions['to']): string[] => {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list
    .flatMap((entry) =>
      typeof entry === 'string' ? entry.split(',') : [entry?.address],
    )
    .map((address) => address?.trim())
    .filter(Boolean)
    .map((address) => address.match(/<([^<>]+)>\s*$/)?.[1] ?? address)
}

const parseProviderMessageId = (response: unknown): string | undefined =>
  typeof response === 'string'
    ? response.match(/^250\s+Ok\s+<?([^\s<>]+)>?/i)?.[1]
    : undefined

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)

  constructor(
    private readonly mailerService: MailerService,
    @InjectModel(SentEmail.name)
    private readonly sentEmailModel: Model<SentEmailDocument>,
  ) {}

  async sendEmail({ to, subject, html, from }, log?: MailLogOptions) {
    const sendMailOptions: ISendMailOptions = {
      to,
      subject,
      html,
    }

    if (from) {
      sendMailOptions['from'] = from
    }

    if (process.env.MAIL_REPLY_TO) {
      sendMailOptions['replyTo'] = process.env.MAIL_REPLY_TO
    }
    const result: SendResult = { sentAt: new Date() }
    try {
      result.info = await this.mailerService.sendMail(sendMailOptions)
    } catch (e) {
      result.error = e?.message ?? String(e)
      this.logger.error(
        `Failed to send email to ${redactRecipient(to)}: ${e?.message}`,
      )
    }

    await this.saveResult(sendMailOptions, result, log, () => html ?? null)
  }

  async sendEmailFromTemplate(
    { to, cc, subject, template, context, from }: ISendMailOptions,
    log?: MailLogOptions,
  ) {
    const sendMailOptions: ISendMailOptions = {
      to,
      cc,
      subject,
      template,
      context: { ...context, ...layoutContext() },
    }

    if (from) {
      sendMailOptions['from'] = from
    }

    if (process.env.MAIL_REPLY_TO) {
      sendMailOptions['replyTo'] = process.env.MAIL_REPLY_TO
    }

    const result: SendResult = { sentAt: new Date() }
    try {
      result.info = await this.mailerService.sendMail(sendMailOptions)
    } catch (e) {
      result.error = e?.message ?? String(e)
      this.logger.error(
        `Failed to send "${template}" email to ${redactRecipient(to)}: ${e?.message}`,
      )
    }

    await this.saveResult(sendMailOptions, result, log, () => {
      const redacted: Record<string, any> = { ...context }
      for (const key of log?.redactContextKeys ?? []) {
        redacted[key] = '[redacted]'
      }
      return renderTemplate(template, redacted)
    })
  }

  private async saveResult(
    options: ISendMailOptions,
    { sentAt, info, error }: SendResult,
    log: MailLogOptions | undefined,
    renderHtml: () => string | null,
  ) {
    try {
      let html: string | null = null
      try {
        html = renderHtml()
      } catch (e) {
        this.logger.warn(`Failed to render stored email body: ${e?.message}`)
      }

      const response =
        typeof info?.response === 'string' ? info.response : undefined
      const from = options.from ?? process.env.MAIL_FROM
      const replyTo = options.replyTo

      await this.sentEmailModel.create({
        source: 'api',
        category: log?.category,
        type: log?.type ?? options.template,
        user: log?.userId,
        to: toAddressList(options.to),
        cc: toAddressList(options.cc),
        from: from ? toAddressList(from as any)[0] : undefined,
        replyTo: replyTo ? toAddressList(replyTo as any)[0] : undefined,
        subject: options.subject,
        html,
        status: error === undefined ? 'sent' : 'failed',
        error,
        providerMessageId: parseProviderMessageId(response),
        providerResponse: response,
        meta: log?.meta ?? {},
        sentAt,
      })
    } catch (e) {
      this.logger.error(`Failed to save email result: ${e?.message}`)
    }
  }
}
