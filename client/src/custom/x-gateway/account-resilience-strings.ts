import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import {
  DEFAULT_CREDENTIAL_WEIGHT,
  DEFAULT_MAX_QUEUE_SIZE,
  type AccountResilienceListResponse,
  type AccountResilienceMutationResponse,
  type AccountResiliencePatch,
  type AccountResiliencePolicy,
} from '../../../../shared/account-resilience'

const en = {
  resilienceTitle: 'Weight, Concurrency & OAuth Circuit',
  weightLabel: 'Weight',
  weightHint: '0 = soft-drain (excludes from routing without deleting credential)',
  drainBadge: 'Draining (0)',
  drainAction: 'Drain (0)',
  restoreWeightAction: 'Restore (1)',
  maxConcurrencyLabel: 'Max concurrency',
  unlimitedPlaceholder: 'Unlimited',
  unlimitedBadge: 'Unlimited',
  failFastLabel: 'Fail-fast',
  failFastHint: 'Reject immediately when busy instead of queuing',
  liveSlotsBadge: '{running} running · {queued} queued',
  liveCapSuffix: 'cap {max}',
  saveResilience: 'Apply',
  savingResilience: 'Saving…',
  savedResilience: 'Saved',
  invalidWeight: 'Weight must be an integer from 0 to 1,000,000.',
  invalidConcurrency: 'Max concurrency must be empty (unlimited) or 1–10,000.',
  circuitHealthy: 'OAuth circuit OK',
  circuitBackoff: 'Refresh backoff ({failures}x)',
  circuitUntil: 'until {until}',
  resetCircuit: 'Reset circuit',
  resettingCircuit: 'Resetting…',
  circuitResetDone: 'Circuit reset',
} as const

export type AccountResilienceStrings = {
  [K in keyof typeof en]: string
}

const vi: AccountResilienceStrings = {
  resilienceTitle: 'Trọng số, Đồng thời & Mạch OAuth',
  weightLabel: 'Trọng số',
  weightHint: '0 = ngừng nhận tải mềm (tạm rút khỏi định tuyến mà không xóa tài khoản)',
  drainBadge: 'Ngừng nhận tải (0)',
  drainAction: 'Ngừng tải (0)',
  restoreWeightAction: 'Khôi phục (1)',
  maxConcurrencyLabel: 'Đồng thời tối đa',
  unlimitedPlaceholder: 'Không giới hạn',
  unlimitedBadge: 'Không giới hạn',
  failFastLabel: 'Từ chối nhanh',
  failFastHint: 'Từ chối ngay khi đầy tải thay vì xếp hàng chờ',
  liveSlotsBadge: '{running} đang chạy · {queued} hàng chờ',
  liveCapSuffix: 'trần {max}',
  saveResilience: 'Áp dụng',
  savingResilience: 'Đang lưu…',
  savedResilience: 'Đã lưu',
  invalidWeight: 'Trọng số phải là số nguyên từ 0 đến 1.000.000.',
  invalidConcurrency: 'Giới hạn đồng thời phải để trống (không giới hạn) hoặc 1–10.000.',
  circuitHealthy: 'Mạch OAuth ổn định',
  circuitBackoff: 'Tạm hoãn làm mới ({failures} lần)',
  circuitUntil: 'đến {until}',
  resetCircuit: 'Đặt lại mạch',
  resettingCircuit: 'Đang đặt lại…',
  circuitResetDone: 'Đã đặt lại mạch',
}

export function useAccountResilienceStrings(): AccountResilienceStrings {
  const { locale } = useI18n()
  return locale === 'vi' ? vi : en
}

export function createFallbackResiliencePolicy(accountId: number): AccountResiliencePolicy {
  return {
    accountId,
    weight: DEFAULT_CREDENTIAL_WEIGHT,
    maxConcurrency: null,
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
    failFast: false,
    refreshCircuitUntil: null,
    refreshFailureCount: 0,
    lastRefreshError: null,
    updatedAt: null,
  }
}

export async function fetchAccountResilienceList(
  signal?: AbortSignal,
): Promise<AccountResilienceListResponse> {
  const res = await apiFetch<Partial<AccountResilienceListResponse> | undefined>(
    '/api/thruline-accounts/resilience',
    { signal },
  )
  return {
    policies: res?.policies && typeof res.policies === 'object' ? res.policies : {},
    semaphores: res?.semaphores && typeof res.semaphores === 'object' ? res.semaphores : {},
    ...(res?.gates && typeof res.gates === 'object' ? { gates: res.gates } : {}),
  }
}

export async function updateAccountResilience(
  accountId: number,
  patch: AccountResiliencePatch,
): Promise<AccountResilienceMutationResponse> {
  const res = await apiFetch<AccountResilienceMutationResponse | undefined>(
    `/api/thruline-accounts/${accountId}/resilience`,
    {
      method: 'PUT',
      body: JSON.stringify(patch),
    },
  )
  if (res && typeof res === 'object' && res.policy) {
    return res
  }
  const fallback = createFallbackResiliencePolicy(accountId)
  return {
    ok: true,
    policy: {
      ...fallback,
      ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
      ...(patch.maxConcurrency !== undefined ? { maxConcurrency: patch.maxConcurrency } : {}),
      ...(patch.maxQueueSize !== undefined ? { maxQueueSize: patch.maxQueueSize } : {}),
      ...(patch.failFast !== undefined ? { failFast: patch.failFast } : {}),
    },
    semaphore: {
      accountId,
      provider: 'unknown',
      running: 0,
      queued: 0,
      maxConcurrency: patch.maxConcurrency ?? null,
      blockedUntil: null,
    },
  }
}

export async function resetAccountRefreshCircuit(
  accountId: number,
): Promise<AccountResilienceMutationResponse> {
  const res = await apiFetch<AccountResilienceMutationResponse | undefined>(
    `/api/thruline-accounts/${accountId}/resilience/reset-circuit`,
    {
      method: 'POST',
      body: '{}',
    },
  )
  if (res && typeof res === 'object' && res.policy) {
    return res
  }
  return {
    ok: true,
    policy: createFallbackResiliencePolicy(accountId),
    semaphore: {
      accountId,
      provider: 'unknown',
      running: 0,
      queued: 0,
      maxConcurrency: null,
      blockedUntil: null,
    },
  }
}
