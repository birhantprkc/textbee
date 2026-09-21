import { OnQueueFailed, Process, Processor } from '@nestjs/bull'
import { InjectModel } from '@nestjs/mongoose'
import { Job } from 'bull'
import { Model, Types } from 'mongoose'
import { MailService } from '../../mail/mail.service'
import { firstName } from '../../mail/first-name'
import { buildEmailContent, subjectForType } from '../notification-content'
import { BILLING_NOTIFICATION_DEDUPE_HOURS } from '../billing-notifications.service'
import { User, UserDocument } from '../../users/schemas/user.schema'
import {
  BillingNotification,
  BillingNotificationDocument,
  BillingNotificationType,
} from '../schemas/billing-notification.schema'

type BillingNotificationJob = Job<{
  notificationId: Types.ObjectId
  userId: Types.ObjectId
  type: string
  title: string
  message: string
  meta: Record<string, any>
  createdAt: Date
  sendEmail?: boolean
}>

@Processor('billing-notifications')
export class BillingNotificationsProcessor {
  constructor(
    private readonly mailService: MailService,
    @InjectModel(BillingNotification.name)
    private readonly notificationModel: Model<BillingNotificationDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  @Process({ name: 'send', concurrency: 1 })
  async handleSend(job: BillingNotificationJob) {
    const payload = job.data
    if (!payload?.sendEmail) {
      return
    }

    const user = await this.userModel.findById(payload.userId)
    if (!user?.email) {
      return
    }

    // Ensure we do not resend within the dedupe window
    const notif = await this.notificationModel.findById(payload.notificationId)
    if (!notif) return
    const windowMs = this.getDedupeWindowMs(payload.type)
    const lastSentAt = notif.lastEmailSentAt
    if (lastSentAt && lastSentAt.getTime() >= Date.now() - windowMs) {
      return
    }

    const subject = subjectForType(payload.type, payload.title)
    // The stored title and message serve the in-app list. The email builds its
    // own copy from the type and the figures already captured in meta.
    const content = buildEmailContent(
      payload.type,
      payload.meta,
      payload.title,
      payload.message,
    )

    await this.mailService.sendEmailFromTemplate({
      to: user.email,
      subject,
      template: 'billing-notification',
      context: {
        ...content,
        name: firstName(user.name),
      },
      from: undefined,
    }, {
      userId: user._id,
      category: 'billing',
      meta: { billingNotificationId: payload.notificationId, notificationType: payload.type },
    })

    await this.notificationModel.updateOne(
      { _id: payload.notificationId },
      { $inc: { sentEmailCount: 1 }, $set: { lastEmailSentAt: new Date() } },
    )
  }

  @OnQueueFailed()
  onFailed(job: BillingNotificationJob, err: Error) {
    console.error('billing notification email failed', {
      notificationId: job?.data?.notificationId,
      type: job?.data?.type,
      error: err?.message,
    })
  }

  private getDedupeWindowMs(type: string) {
    const hours = BILLING_NOTIFICATION_DEDUPE_HOURS[type as BillingNotificationType] ?? 24
    return hours * 60 * 60 * 1000
  }
}
