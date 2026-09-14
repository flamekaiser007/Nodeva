import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ResultsList from './ResultsList'

function candidate(overrides = {}) {
  return {
    node: {
      id: 'node-1', gpu_model: 'RTX 4090', gpu_vram_mb: 24576, cpu_cores: 16,
      ram_mb: 32768, price_paise_hr: 4300, reliability: 0.95, ...overrides.node,
    },
    score: 0.8, quoted_paise: 4300, expected_cost_paise: 4526,
    verification_recommended: false, verification_reasons: [],
    ...overrides,
  }
}

test('renders nothing while results are null (search not yet run)', () => {
  const { container } = render(<ResultsList results={null} onReserve={() => {}} />)
  expect(container).toBeEmptyDOMElement()
})

test('shows an empty-state message for zero results, not a blank list', () => {
  render(<ResultsList results={[]} onReserve={() => {}} />)
  expect(screen.getByText(/no provider currently matches/i)).toBeInTheDocument()
})

test('the first result is marked top match when not in verification-picking mode', () => {
  render(<ResultsList results={[candidate(), candidate({ node: { id: 'node-2' } })]} onReserve={() => {}} />)
  expect(screen.getByText(/top match/i)).toBeInTheDocument()
})

test('a verification_recommended candidate shows its reasons', () => {
  render(<ResultsList
    results={[candidate({ verification_recommended: true, verification_reasons: ['new_provider', 'high_value_job'] })]}
    onReserve={() => {}} />)
  const badge = screen.getByText(/verification suggested/i)
  expect(badge.parentElement).toHaveTextContent('new provider, higher-value booking')
})

test('clicking "Verify with another node" tells the parent which candidate is primary', async () => {
  const onStartVerification = vi.fn()
  const user = userEvent.setup()
  render(<ResultsList results={[candidate()]} onReserve={() => {}} onStartVerification={onStartVerification} />)

  await user.click(screen.getByRole('button', { name: /verify with another node/i }))
  expect(onStartVerification).toHaveBeenCalledWith(expect.objectContaining({ node: expect.objectContaining({ id: 'node-1' }) }))
})

describe('partner-picking mode (verifyPrimary set)', () => {
  test('the primary candidate is disabled and labeled, not offered as its own partner', () => {
    const primary = candidate()
    render(<ResultsList
      results={[primary, candidate({ node: { id: 'node-2' } })]}
      verifyPrimary={primary}
      onReserve={() => {}} onPickPartner={() => {}} onCancelVerification={() => {}} />)

    expect(screen.getByText(/picked as primary/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /same node/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^verify with this node$/i })).toBeEnabled()
  })

  test('picking a partner calls onPickPartner with the OTHER candidate, not the primary', async () => {
    const onPickPartner = vi.fn()
    const primary = candidate()
    const partner = candidate({ node: { id: 'node-2', gpu_model: 'RTX 3090' } })
    const user = userEvent.setup()
    render(<ResultsList
      results={[primary, partner]}
      verifyPrimary={primary}
      onReserve={() => {}} onPickPartner={onPickPartner} onCancelVerification={() => {}} />)

    await user.click(screen.getByRole('button', { name: /^verify with this node$/i }))
    expect(onPickPartner).toHaveBeenCalledWith(expect.objectContaining({ node: expect.objectContaining({ id: 'node-2' }) }))
  })

  test('cancel exits picking mode via the parent callback', async () => {
    const onCancelVerification = vi.fn()
    const primary = candidate()
    const user = userEvent.setup()
    render(<ResultsList
      results={[primary]}
      verifyPrimary={primary}
      onReserve={() => {}} onPickPartner={() => {}} onCancelVerification={onCancelVerification} />)

    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancelVerification).toHaveBeenCalled()
  })

  test('normal Reserve buttons are replaced entirely while picking a partner', () => {
    const primary = candidate()
    render(<ResultsList
      results={[primary]}
      verifyPrimary={primary}
      onReserve={() => {}} onPickPartner={() => {}} onCancelVerification={() => {}} />)
    expect(screen.queryByRole('button', { name: /^reserve$/i })).not.toBeInTheDocument()
  })
})
