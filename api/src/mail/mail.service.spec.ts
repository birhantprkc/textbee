import { MailService } from './mail.service'

const build = () => {
  const mailerService: any = { sendMail: jest.fn().mockResolvedValue(undefined) }
  const sentEmailModel: any = { create: jest.fn().mockResolvedValue({}) }
  return {
    service: new MailService(mailerService, sentEmailModel),
    mailerService,
    sentEmailModel,
  }
}

describe('MailService', () => {
  beforeEach(() => jest.clearAllMocks())

  it('adds the shared layout context to every templated email', async () => {
    const { service, mailerService } = build()

    await service.sendEmailFromTemplate({
      to: 'user@example.com',
      subject: 'Password reset',
      template: 'password-reset-request',
      context: { name: 'Ada' },
    })

    const { context } = mailerService.sendMail.mock.calls[0][0]
    expect(context).toMatchObject({
      name: 'Ada',
      brandName: 'textbee.dev',
      year: new Date().getFullYear(),
    })
  })

  it('keeps the shared layout values authoritative', async () => {
    const { service, mailerService } = build()

    await service.sendEmailFromTemplate({
      to: 'user@example.com',
      subject: 'Password reset',
      template: 'password-reset-request',
      context: { brandName: 'somewhere-else', year: 1999 },
    })

    const { context } = mailerService.sendMail.mock.calls[0][0]
    expect(context.brandName).toBe('textbee.dev')
    expect(context.year).toBe(new Date().getFullYear())
  })

  it('works when a caller passes no context at all', async () => {
    const { service, mailerService } = build()

    await service.sendEmailFromTemplate({
      to: 'user@example.com',
      subject: 'Password reset',
      template: 'password-reset-request',
    })

    expect(mailerService.sendMail.mock.calls[0][0].context).toMatchObject({
      brandName: 'textbee.dev',
    })
  })

  const logRecipientFor = async (to: unknown) => {
    const { service, mailerService } = build()
    const logger = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined)
    mailerService.sendMail.mockRejectedValue(new Error('smtp down'))

    await service.sendEmailFromTemplate({
      to: to as any,
      subject: 'Password reset',
      template: 'password-reset-request',
    })

    return logger.mock.calls[0][0] as string
  }

  it.each([
    ['Ada Lovelace <someone@example.com>'],
    [['a@example.com', 'b@example.com']],
    [{ name: 'Ada' }],
    [''],
  ])('redacts a recipient it cannot mask safely: %p', async (to) => {
    const message = await logRecipientFor(to)
    expect(message).toContain('password-reset-request')
    expect(message).toMatch(/to (redacted|unknown recipient): smtp down$/)
  })

  it('masks a structured recipient by its address alone', async () => {
    const message = await logRecipientFor({
      name: 'Ada Lovelace',
      address: 'someone@example.com',
    })
    expect(message).toMatch(/to so\*\*\*@example\.com: smtp down$/)
    expect(message).not.toContain('Ada Lovelace')
  })

  it('masks a single-entry recipient list', async () => {
    const message = await logRecipientFor(['someone@example.com'])
    expect(message).toMatch(/to so\*\*\*@example\.com: smtp down$/)
  })

  it('swallows a send failure and logs a redacted recipient', async () => {
    const { service, mailerService } = build()
    const logger = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined)
    mailerService.sendMail.mockRejectedValue(new Error('smtp down'))

    await expect(
      service.sendEmailFromTemplate({
        to: 'someone@example.com',
        subject: 'Password reset',
        template: 'password-reset-request',
        context: {},
      }),
    ).resolves.toBeUndefined()

    const message = logger.mock.calls[0][0] as string
    expect(message).toBe(
      'Failed to send "password-reset-request" email to so***@example.com: smtp down',
    )
  })

  describe('delivery results', () => {
    const quiet = (service: MailService) => {
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined)
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined)
    }

    it('saves a sent result with the provider message id', async () => {
      const { service, mailerService, sentEmailModel } = build()
      mailerService.sendMail.mockResolvedValue({
        messageId: '<local@example.com>',
        response: '250 Ok 0100018abc-1234-5678-000000',
      })

      await service.sendEmailFromTemplate(
        {
          to: 'Ada <ada@example.com>',
          cc: 'admin@example.com',
          subject: 'Password reset',
          template: 'password-reset-success',
          context: { name: 'Ada' },
        },
        { userId: 'u1', category: 'auth', meta: { a: 1 } },
      )

      const doc = sentEmailModel.create.mock.calls[0][0]
      expect(doc).toMatchObject({
        source: 'api',
        category: 'auth',
        type: 'password-reset-success',
        user: 'u1',
        to: ['ada@example.com'],
        cc: ['admin@example.com'],
        subject: 'Password reset',
        status: 'sent',
        providerMessageId: '0100018abc-1234-5678-000000',
        providerResponse: '250 Ok 0100018abc-1234-5678-000000',
        meta: { a: 1 },
      })
      expect(doc.error).toBeUndefined()
      expect(doc.sentAt).toBeInstanceOf(Date)
      expect(doc.html).toContain('Ada')
    })

    it('saves a failed result and does not throw', async () => {
      const { service, mailerService, sentEmailModel } = build()
      quiet(service)
      mailerService.sendMail.mockRejectedValue(new Error('smtp down'))

      await expect(
        service.sendEmailFromTemplate(
          {
            to: 'ada@example.com',
            subject: 'Password reset',
            template: 'password-reset-success',
            context: { name: 'Ada' },
          },
          { category: 'auth' },
        ),
      ).resolves.toBeUndefined()

      expect(sentEmailModel.create.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error: 'smtp down',
      })
      expect(
        sentEmailModel.create.mock.calls[0][0].providerMessageId,
      ).toBeUndefined()
    })

    it('keeps redacted values out of the saved body but sends them', async () => {
      const { service, mailerService, sentEmailModel } = build()
      const otp = '482913'
      const resetLink = 'https://textbee.dev/reset-password?otp=482913'

      await service.sendEmailFromTemplate(
        {
          to: 'ada@example.com',
          subject: 'Password reset',
          template: 'password-reset-request',
          context: { name: 'Ada', otp, resetLink },
        },
        { category: 'auth', redactContextKeys: ['otp', 'resetLink'] },
      )

      expect(mailerService.sendMail.mock.calls[0][0].context).toMatchObject({
        otp,
        resetLink,
      })
      const { html } = sentEmailModel.create.mock.calls[0][0]
      expect(html).toContain('[redacted]')
      expect(html).not.toContain(otp)
      expect(html).not.toContain('reset-password')
    })

    it('saves a null body when rendering fails', async () => {
      const { service, sentEmailModel } = build()
      quiet(service)

      await service.sendEmailFromTemplate(
        { to: 'ada@example.com', subject: 'x', template: 'no-such-template' },
        { category: 'auth' },
      )

      expect(sentEmailModel.create.mock.calls[0][0]).toMatchObject({
        status: 'sent',
        html: null,
      })
    })

    it('does not throw when saving the result fails', async () => {
      const { service, mailerService, sentEmailModel } = build()
      quiet(service)
      sentEmailModel.create.mockRejectedValue(new Error('db down'))

      await expect(
        service.sendEmailFromTemplate(
          {
            to: 'ada@example.com',
            subject: 'Password reset',
            template: 'password-reset-success',
            context: { name: 'Ada' },
          },
          { category: 'auth' },
        ),
      ).resolves.toBeUndefined()
      expect(mailerService.sendMail).toHaveBeenCalledTimes(1)
    })

    it('saves results for plain html sends', async () => {
      const { service, mailerService, sentEmailModel } = build()
      mailerService.sendMail.mockResolvedValue({ response: '250 Ok abc-1' })

      await service.sendEmail(
        { to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', from: undefined },
        { category: 'other', type: 'plain' },
      )

      expect(sentEmailModel.create.mock.calls[0][0]).toMatchObject({
        type: 'plain',
        html: '<p>Hi</p>',
        status: 'sent',
        providerMessageId: 'abc-1',
      })
    })
  })
})
