import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ActiveReservation from './ActiveReservation'
import { api } from '../api'
import { confirmAndPay } from '../lib/confirmPayment'

vi.mock('../api', () => ({
  api: { submitJob: vi.fn(), getJob: vi.fn() },
}))

vi.mock('../lib/confirmPayment', () => ({
  confirmAndPay: vi.fn(),
  RAZORPAY_HANDLED: '__razorpay_already_handled__',
}))

function reservation(overrides = {}) {
  return { reservation_id: 'res-1', status: 'held', quoted_paise: 4300, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('a held reservation shows the confirm button with the exact quoted price', () => {
  render(<ActiveReservation reservation={reservation()} />)
  expect(screen.getByRole('button', { name: /confirm & pay ₹43\.00/i })).toBeInTheDocument()
})

test('confirming moves straight to the job form once the backend reports confirmed', async () => {
  confirmAndPay.mockResolvedValue('confirmed')
  const user = userEvent.setup()
  render(<ActiveReservation reservation={reservation()} />)

  await user.click(screen.getByRole('button', { name: /confirm & pay/i }))

  await waitFor(() => expect(screen.getByRole('button', { name: /submit job/i })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /confirm & pay/i })).not.toBeInTheDocument()
})

test('submitting a job sends the shell command wrapped for /bin/sh -c', async () => {
  api.submitJob.mockResolvedValue({ job_id: 'job-1' })
  const user = userEvent.setup()
  render(<ActiveReservation reservation={reservation({ status: 'confirmed' })} />)

  await user.click(screen.getByRole('button', { name: /submit job/i }))

  expect(api.submitJob).toHaveBeenCalledWith('res-1', expect.objectContaining({
    command: ['/bin/sh', '-c', 'echo hello from your reserved GPU node'],
  }))
})

describe('job polling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a terminal job status stops polling and calls onSettled after the debounce', async () => {
    api.submitJob.mockResolvedValue({ job_id: 'job-1' })
    api.getJob.mockResolvedValue({ job_id: 'job-1', status: 'succeeded', stdout: 'hi\n' })
    const onSettled = vi.fn()

    render(<ActiveReservation reservation={reservation({ status: 'confirmed' })} onSettled={onSettled} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /submit job/i })) })

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText(/hi/)).toBeInTheDocument()
    expect(onSettled).not.toHaveBeenCalled() // the 500ms debounce hasn't elapsed yet

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(onSettled).toHaveBeenCalledWith('res-1')

    // Polling must actually have stopped -- getJob call count shouldn't
    // keep climbing after the job reached a terminal status.
    const callsAtSettle = api.getJob.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(api.getJob.mock.calls.length).toBe(callsAtSettle)
  })

  test('a still-running job keeps polling and does not call onSettled', async () => {
    api.submitJob.mockResolvedValue({ job_id: 'job-1' })
    api.getJob.mockResolvedValue({ job_id: 'job-1', status: 'running' })
    const onSettled = vi.fn()

    render(<ActiveReservation reservation={reservation({ status: 'confirmed' })} onSettled={onSettled} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /submit job/i })) })

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(onSettled).not.toHaveBeenCalled()
    expect(api.getJob.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
