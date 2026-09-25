'use client'

import { Card, CardContent } from '@/components/ui/card'
import { BarChart3, Smartphone, Key, MessageSquare } from 'lucide-react'
import GetStartedCard from './get-started'
import UsageSummary from './billing/usage-summary'
import { useApiKeys, useDevices, useGatewayStats } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'

// Compact all-time totals. Deliberately no trend indicators: the stats
// endpoint returns running totals with no time window, so there is nothing to
// compare against and any arrow would be invented.
function Stat({
  label,
  value,
  caption,
  icon: Icon,
}: {
  label: string
  value: string | number | undefined
  caption: string
  icon: typeof MessageSquare
}) {
  return (
    <div className='flex items-start justify-between gap-3 bg-card px-4 py-3.5'>
      <div className='min-w-0'>
        <p className='label-mono truncate'>{label}</p>
        <div className='num mt-2 text-2xl font-semibold leading-none tracking-tight'>
          {value !== undefined ? value : <Skeleton className='h-6 w-14' />}
        </div>
        {caption && (
          <p className='mt-1.5 truncate text-xs text-muted-foreground'>{caption}</p>
        )}
      </div>
      <Icon className='h-4 w-4 shrink-0 text-muted-foreground' />
    </div>
  )
}

export function Totals() {
  const { data: stats } = useGatewayStats()
  const { data: devices } = useDevices()
  const { data: apiKeys } = useApiKeys('active')

  // The stats endpoint counts every device, enabled or not, so "enabled" has
  // to be derived from the device list we already fetch.
  const enabledDevices = devices?.filter((d) => d.enabled).length
  const totalDevices = devices?.length ?? stats?.totalDeviceCount

  return (
    <Card className='overflow-hidden'>
      <CardContent className='grid grid-cols-1 gap-px overflow-hidden bg-border p-0 sm:grid-cols-2 lg:grid-cols-4'>
        <Stat
          label='SMS sent'
          caption='all time'
          value={stats?.totalSentSMSCount?.toLocaleString()}
          icon={MessageSquare}
        />
        <Stat
          label='SMS received'
          caption='all time'
          value={stats?.totalReceivedSMSCount?.toLocaleString()}
          icon={BarChart3}
        />
        <Stat
          label='Devices'
          caption={
            enabledDevices !== undefined ? `${enabledDevices} enabled` : ''
          }
          value={totalDevices}
          icon={Smartphone}
        />
        <Stat
          label='API keys'
          caption='active'
          value={apiKeys?.length ?? stats?.totalApiKeyCount}
          icon={Key}
        />
      </CardContent>
    </Card>
  )
}

export default function Overview() {
  return (
    <div className='space-y-6'>
      <GetStartedCard />
      <UsageSummary />
      <Totals />
    </div>
  )
}
