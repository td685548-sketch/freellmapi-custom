import { describe, expect, it } from 'vitest'
import { memberEndpointTitle, memberProviderLabel, providerPinId } from '@/lib/routing'

describe('endpoint identity across paged model groups', () => {
  it('names and pins the correct endpoint when its sibling is outside the loaded page', () => {
    const row = { platform: 'custom', source: 'custom' as const, modelId: 'same-model', keyLabel: 'Relay',
      endpointScope: 'https://relay-a.example/v1', qualifiedModelId: 'custom:same-model@relay-a', endpointCollision: true }
    expect(memberProviderLabel(row, [row])).toContain('relay-a.example/v1')
    expect(memberEndpointTitle(row, [row])).toBe(row.endpointScope)
    expect(providerPinId(row, [row])).toBe(row.qualifiedModelId)
    expect(memberEndpointTitle({ ...row, endpointCollision: false }, [row])).toBeUndefined()
  })
})
