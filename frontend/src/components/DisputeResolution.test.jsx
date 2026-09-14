import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DisputeResolution from './DisputeResolution'
import { api } from '../api'
import { confirmAndPay } from '../lib/confirmPayment'

vi.mock('../api', () => ({
  api: {
    getDisputeResolution: vi.fn(),
    search: vi.fn(),
    reserve: vi.fn(),
    submitTiebreaker: vi.fn(),
  },
}))

vi.mock('../lib/confirmPayment', () => ({
  confirmAndPay: vi.fn(),
  RAZORPAY_HANDLED: '__razorpay_already_handled__',
}))

beforeEach(() => {
  vi.clearAllMocks()
})

test('shows a checking state before the resolution lookup resolves', () => {
  api.getDisputeResolution.mockReturnValue(new Promise(() => {})) // never resolves
  render(<DisputeResolution groupId="g1" />)
  expect(screen.getByText(/checking for an existing resolution/i)).toBeInTheDocument()
})

test('the money-is-final framing is always shown, regardless of resolution state', async () => {
  api.getDisputeResolution.mockRejectedValue(new Error('not found'))
  render(<DisputeResolution groupId="g1" />)
  expect(screen.getByText(/refunded in full already/i)).toBeInTheDocument()
})

describe('an already-resolved dispute', () => {
  test('an attributed verdict names which reservation was vindicated vs at fault', async () => {
    api.getDisputeResolution.mockResolvedValue({
      verdict: 'attributed',
      vindicated_reservation_id: 'aaaaaaaa-1111-1111-1111-111111111111',
      at_fault_reservation_id: 'bbbbbbbb-2222-2222-2222-222222222222',
    })
    render(<DisputeResolution groupId="g1" />)

    await waitFor(() => expect(screen.getByText('Fault attributed')).toBeInTheDocument())
    expect(screen.getByText(/aaaaaaaa/)).toBeInTheDocument()
    expect(screen.getByText(/bbbbbbbb/)).toBeInTheDocument()
    expect(screen.getByText(/found at fault/i)).toBeInTheDocument()
  })

  test('an inconclusive verdict says fault could not be attributed to either', async () => {
    api.getDisputeResolution.mockResolvedValue({ verdict: 'inconclusive' })
    render(<DisputeResolution groupId="g1" />)

    await waitFor(() => expect(screen.getByText('Inconclusive')).toBeInTheDocument())
    expect(screen.getByText(/cannot be.*attributed to either one/i)).toBeInTheDocument()
  })
})

describe('the tiebreaker flow, end to end', () => {
  test('search -> reserve -> confirm -> submit -> resolved', async () => {
    api.getDisputeResolution
      .mockRejectedValueOnce(new Error('not resolved yet')) // initial check
      .mockRejectedValueOnce(new Error('still not resolved')) // first poll tick
      .mockResolvedValueOnce({ verdict: 'inconclusive' }) // second poll tick

    api.search.mockResolvedValue({
      results: [
        { node: { id: 'node-3', gpu_model: 'RTX 3090' }, quoted_paise: 2150 },
        { node: { id: 'excluded-node', gpu_model: 'Excluded' }, quoted_paise: 2150 },
      ],
    })
    api.reserve.mockResolvedValue({ reservation_id: 'res-tiebreak', status: 'held' })
    confirmAndPay.mockResolvedValue('confirmed')
    api.submitTiebreaker.mockResolvedValue({ job_id: 'job-tiebreak' })

    const user = userEvent.setup()
    render(<DisputeResolution groupId="g1" excludeNodeIds={['excluded-node']} />)

    await waitFor(() => expect(screen.getByText(/find a third, independent node/i)).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /find compute/i }))
    await waitFor(() => expect(screen.getByText(/RTX 3090/)).toBeInTheDocument())
    // The node explicitly excluded (one of the two original disputing
    // nodes) must never be offered as a tiebreaker candidate.
    expect(screen.queryByText(/Excluded/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /use this node/i }))
    expect(api.reserve).toHaveBeenCalledWith('node-3', expect.anything(), expect.anything())
    await waitFor(() => expect(screen.getByText(/awaiting payment/i)).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /confirm & pay/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /run tiebreaker job/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /run tiebreaker job/i }))
    expect(api.submitTiebreaker).toHaveBeenCalledWith('g1', 'res-tiebreak')
    await waitFor(() => expect(screen.getByText(/waiting for the tiebreaker job/i)).toBeInTheDocument())

    await waitFor(() => expect(screen.getByText('Inconclusive')).toBeInTheDocument(), { timeout: 3000 })
  })
})
