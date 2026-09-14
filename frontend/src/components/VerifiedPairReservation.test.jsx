import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VerifiedPairReservation from './VerifiedPairReservation'
import { api } from '../api'
import { confirmAndPay, RAZORPAY_HANDLED } from '../lib/confirmPayment'

vi.mock('../api', () => ({
  api: {
    getReservation: vi.fn(),
    submitJob: vi.fn(),
    getJob: vi.fn(),
  },
}))

vi.mock('../lib/confirmPayment', () => ({
  confirmAndPay: vi.fn(),
  RAZORPAY_HANDLED: '__razorpay_already_handled__',
}))

function makePair(overrides = {}) {
  return {
    a: {
      reservation_id: 'res-a', status: 'held', quoted_paise: 4300,
      node_id: 'node-a', node_model: 'RTX 4090 #A', ...overrides.a,
    },
    b: {
      reservation_id: 'res-b', status: 'held', quoted_paise: 4300,
      node_id: 'node-b', node_model: 'RTX 4090 #B', ...overrides.b,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// This is the exact bug caught live in the browser (see the component's
// own comment): switching away and back unmounted/remounted this
// component, and useState(pair.a) re-seeded from the booking-time prop --
// a reservation confirmed minutes earlier silently showed "held" again.
// The fix re-fetches real status on every mount; this proves that fetch
// actually overrides the stale prop rather than merely existing.
describe('remount hydration', () => {
  test('overrides a stale "held" prop with the real "confirmed" status from the backend', async () => {
    const pair = makePair() // both props say 'held'
    api.getReservation.mockImplementation(async (id) => ({
      reservation_id: id, status: 'confirmed', job: null,
    }))

    render(<VerifiedPairReservation pair={pair} />)

    expect(screen.getByText(/checking the current status/i)).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getAllByText('Confirmed')).toHaveLength(2)
    })
    expect(screen.queryByText(/held — awaiting payment/i)).not.toBeInTheDocument()
  });

  test('recovers an already-finished job from a previous mount and shows its output', async () => {
    const pair = makePair()
    api.getReservation.mockImplementation(async (id) => ({
      reservation_id: id, status: 'completed',
      job: id === 'res-a'
        ? { job_id: 'job-1', status: 'succeeded', stdout: 'hello from a previous mount\n' }
        : null,
    }))

    render(<VerifiedPairReservation pair={pair} />)

    await waitFor(() => {
      expect(screen.getByText(/hello from a previous mount/)).toBeInTheDocument()
    })
    // The submission form must not reappear for a reservation that already
    // has a job -- resubmitting would hit "reservation already has a job".
    expect(screen.queryByText(/submit job to both nodes/i)).not.toBeInTheDocument()
  });

  test('resumes polling a still-running job recovered on remount, until it settles', async () => {
    vi.useFakeTimers()
    try {
      const pair = makePair()
      let reservationStatus = 'running'
      api.getReservation.mockImplementation(async (id) => ({
        reservation_id: id, status: reservationStatus,
        job: id === 'res-a' ? { job_id: 'job-1', status: 'running' } : null,
      }))
      api.getJob.mockResolvedValue({ job_id: 'job-1', status: 'running' })

      render(<VerifiedPairReservation pair={pair} />)
      await act(async () => { await vi.runOnlyPendingTimersAsync() })

      expect(screen.getByText(/waiting for both nodes to finish/i)).toBeInTheDocument()

      // The job finishes and the reservations settle between poll ticks --
      // exactly the "settleVerificationGroup runs asynchronously" case the
      // component's own comment describes.
      api.getJob.mockResolvedValue({ job_id: 'job-1', status: 'succeeded', stdout: 'done\n' })
      reservationStatus = 'completed'

      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

      expect(screen.getByText(/done/)).toBeInTheDocument()
      expect(screen.getAllByText('Completed')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  });
});

describe('confirming a node', () => {
  test('a successful confirm updates that node\'s status without touching the other', async () => {
    const pair = makePair()
    api.getReservation.mockImplementation(async (id) => ({
      reservation_id: id, status: 'held', job: null,
    }))
    confirmAndPay.mockResolvedValue('confirmed')

    render(<VerifiedPairReservation pair={pair} />)
    await waitFor(() => expect(screen.getAllByText(/held — awaiting payment/i)).toHaveLength(2))

    const user = userEvent.setup()
    const [confirmA] = screen.getAllByRole('button', { name: /confirm & pay/i })
    await user.click(confirmA)

    await waitFor(() => {
      expect(screen.getByText('Confirmed')).toBeInTheDocument()
    })
    expect(screen.getByText(/held — awaiting payment/i)).toBeInTheDocument()
    expect(confirmAndPay).toHaveBeenCalledWith('res-a', expect.objectContaining({ description: expect.any(String) }))
  });

  test('a RAZORPAY_HANDLED rejection does not surface a duplicate generic error', async () => {
    const pair = makePair()
    api.getReservation.mockImplementation(async (id) => ({ reservation_id: id, status: 'held', job: null }))
    confirmAndPay.mockImplementation(async (_id, { onError }) => {
      onError('Payment cancelled.')
      throw new Error(RAZORPAY_HANDLED)
    })

    render(<VerifiedPairReservation pair={pair} />)
    await waitFor(() => expect(screen.getAllByText(/held — awaiting payment/i)).toHaveLength(2))

    const user = userEvent.setup()
    const [confirmA] = screen.getAllByRole('button', { name: /confirm & pay/i })
    await user.click(confirmA)

    await waitFor(() => expect(screen.getByText('Payment cancelled.')).toBeInTheDocument())
    // Only the one error onError reported -- not a second, generic message
    // from the catch block re-reporting the sentinel itself.
    expect(screen.getAllByText(/payment cancelled/i)).toHaveLength(1)
  });
});

describe('submitting the verification job', () => {
  test('submits with verify_against_reservation_id pointing at the sibling reservation', async () => {
    const pair = makePair({ a: { status: 'confirmed' }, b: { status: 'confirmed' } })
    api.getReservation.mockImplementation(async (id) => ({ reservation_id: id, status: 'confirmed', job: null }))
    api.submitJob.mockResolvedValue({ job_id: 'job-99' })

    render(<VerifiedPairReservation pair={pair} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /submit job to both nodes/i })).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /submit job to both nodes/i }))

    await waitFor(() => expect(api.submitJob).toHaveBeenCalled())
    expect(api.submitJob).toHaveBeenCalledWith('res-a', expect.objectContaining({
      verify_against_reservation_id: 'res-b',
    }))
  });
});
