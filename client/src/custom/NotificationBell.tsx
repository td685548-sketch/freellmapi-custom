import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bell, CheckCheck, ExternalLink, Info, ShieldAlert, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { useSessionRevision } from './session-state'
import { useUserSession } from './use-session'
import { useCustomT } from './i18n/use-custom-t'

export interface UserNotificationItem {
  id: number
  userId: number
  category: 'provider_health' | 'registration' | 'quota' | 'security' | 'system'
  severity: 'info' | 'warning' | 'critical'
  title: string
  body: string
  actionUrl: string | null
  readAt: string | null
  createdAt: string
}

interface NotificationsResponse {
  notifications: UserNotificationItem[]
  unreadCount: number
}

function formatRelativeTime(iso: string, isVi: boolean): string {
  const ts = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  if (!Number.isFinite(ts)) return iso
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return isVi ? 'vừa xong' : 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return isVi ? `${diffMin} phút trước` : `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return isVi ? `${diffHour} giờ trước` : `${diffHour}h ago`
  const diffDay = Math.floor(diffHour / 24)
  return isVi ? `${diffDay} ngày trước` : `${diffDay}d ago`
}

function SeverityIcon({ severity }: { severity: UserNotificationItem['severity'] }) {
  if (severity === 'critical') {
    return <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
  }
  if (severity === 'warning') {
    return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
  }
  return <Info className="mt-0.5 size-4 shrink-0 text-blue-500" />
}

export function NotificationBell({ variant = 'navbar' }: { variant?: 'navbar' | 'thruline' }) {
  const tc = useCustomT()
  const { locale } = useI18n()
  const isVi = locale === 'vi'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const revision = useSessionRevision()
  const { session } = useUserSession()
  const [open, setOpen] = useState(false)

  const queryKey = ['user-notifications', revision]
  const { data } = useQuery<NotificationsResponse>({
    queryKey,
    queryFn: () => apiFetch<NotificationsResponse>('/api/user/notifications?limit=35'),
    enabled: Boolean(session?.userId),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  })

  const markOneMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ updated: boolean; unreadCount: number }>(`/api/user/notifications/${id}/read`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey })
    },
  })

  const markAllMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ updatedCount: number; unreadCount: number }>('/api/user/notifications/read-all', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey })
    },
  })

  const clearReadMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ deletedCount: number; unreadCount: number }>('/api/user/notifications/read', {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey })
    },
  })

  if (!session?.userId) return null

  const notifications = data?.notifications ?? []
  const unreadCount = data?.unreadCount ?? 0
  const hasReadItems = notifications.some((item) => item.readAt !== null)

  const handleSelectItem = (item: UserNotificationItem) => {
    if (!item.readAt) {
      markOneMutation.mutate(item.id)
    }
    if (item.actionUrl) {
      setOpen(false)
      navigate(item.actionUrl)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={tc('Notifications')}
        className={
          variant === 'thruline'
            ? 'x-icon-button relative'
            : `${buttonVariants({ variant: 'ghost', size: 'icon' })} relative`
        }
      >
        <Bell className={variant === 'thruline' ? 'size-[18px]' : 'size-4'} />
        {unreadCount > 0 && (
          <span
            aria-label={`${unreadCount} ${tc('unread notifications')}`}
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-white"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-88 max-w-[92vw] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">{tc('Notifications')}</span>
            {unreadCount > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={markAllMutation.isPending}
                onClick={() => markAllMutation.mutate()}
                title={tc('Mark all as read')}
              >
                <CheckCheck className="mr-1 size-3.5" />
                {tc('Read all')}
              </Button>
            )}
            {hasReadItems && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={clearReadMutation.isPending}
                onClick={() => clearReadMutation.mutate()}
                title={tc('Clear read notifications')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>

        {notifications.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {tc('No notifications yet.')}
          </div>
        ) : (
          <ul className="max-h-88 divide-y overflow-y-auto">
            {notifications.map((item) => {
              const unread = item.readAt === null
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectItem(item)}
                    className={`flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/60 ${
                      unread ? 'bg-primary/[0.04]' : 'opacity-75'
                    }`}
                  >
                    <SeverityIcon severity={item.severity} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`truncate text-xs ${unread ? 'font-semibold text-foreground' : 'font-medium text-foreground/85'}`}>
                          {item.title}
                        </span>
                        {unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                      </div>
                      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {item.body}
                      </p>
                      <div className="flex items-center gap-2 pt-0.5 text-[10px] text-muted-foreground/80">
                        <span>{formatRelativeTime(item.createdAt, isVi)}</span>
                        {item.actionUrl && (
                          <span className="inline-flex items-center gap-0.5 text-primary">
                            {tc('Open')}
                            <ExternalLink className="size-2.5" />
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
