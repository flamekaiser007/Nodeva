import { test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../api', () => ({
  api: { listNodes: vi.fn() },
}))

import { api } from '../api'
import BrowseNodes from './BrowseNodes'

const HOUR = 3_600_000

function node(overrides = {}) {
  const start = Date.now() + HOUR
  return {
    id: 'node-1', gpu_model: 'RTX 4090', gpu_vram_mb: 24576, cpu_cores: 16,
    ram_mb: 32768, price_paise_hr: 4300, reliability: 0.95, rep_jobs_total: 20,
    availability: [{ start, end: start + 2 * HOUR }],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listNodes.mockResolvedValue({ nodes: [] })
})

test('loads the catalogue on mount without the user having to search first', async () => {
  // The whole point of this view: /search requires requirements and a time
  // window up front, which a new user does not yet have.
  api.listNodes.mockResolvedValue({ nodes: [node()] })
  render(<BrowseNodes onReserve={() => {}} reservingId={null} />)

  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
  expect(api.listNodes).toHaveBeenCalledTimes(1)
})

test('shows each machine\'s real specs and hourly price', async () => {
  api.listNodes.mockResolvedValue({ nodes: [node()] })
  render(<BrowseNodes onReserve={() => {}} reservingId={null} />)

  expect(await screen.findByText(/24 GB VRAM · 16 cores · 32 GB RAM/)).toBeInTheDocument()
  expect(screen.getByText('₹43.00/hr')).toBeInTheDocument()
})

test('shows when each machine is actually available, not just that it exists', async () => {
  // A listing with no bookable window was the exact thing that made search
  // return "no provider matches" for a node the provider could see online.
  api.listNodes.mockResolvedValue({ nodes: [node()] })
  render(<BrowseNodes onReserve={() => {}} reservingId={null} />)

  // A concrete window with a readable duration, not just "this node exists".
  expect(await screen.findByText(/→/)).toBeInTheDocument()
  expect(screen.getByText(/\(2h\)/)).toBeInTheDocument()
})

test('renting a window passes that exact node and window up', async () => {
  const onReserve = vi.fn()
  const n = node()
  api.listNodes.mockResolvedValue({ nodes: [n] })
  render(<BrowseNodes onReserve={onReserve} reservingId={null} />)

  await userEvent.click(await screen.findByRole('button', { name: /rent this window/i }))

  expect(onReserve).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'node-1' }),
    n.availability[0],
  )
})

test('a machine with several windows offers each one separately', async () => {
  const start = Date.now() + HOUR
  api.listNodes.mockResolvedValue({
    nodes: [node({
      availability: [
        { start, end: start + HOUR },
        { start: start + 5 * HOUR, end: start + 8 * HOUR },
      ],
    })],
  })
  render(<BrowseNodes onReserve={() => {}} reservingId={null} />)

  expect(await screen.findAllByRole('button', { name: /rent this window/i })).toHaveLength(2)
})

test('the empty state explains WHY nothing is listed', async () => {
  // "None" alone sent providers hunting for a bug. The two real causes are
  // not running the worker, and not having set an availability window.
  render(<BrowseNodes onReserve={() => {}} reservingId={null} />)

  expect(await screen.findByText(/no machines are available/i)).toBeInTheDocument()
  expect(screen.getByText(/running the worker/i)).toBeInTheDocument()
  expect(screen.getByText(/availability window/i)).toBeInTheDocument()
})

test('a node with no verified track record says so rather than looking proven', async () => {
  api.listNodes.mockResolvedValue({ nodes: [node({ rep_jobs_total: 0, reliability: 0.8 })] })
  render(<BrowseNodes onReserve={() => {}} reservingId={null} />)

  expect(await screen.findByText(/no track record yet/i)).toBeInTheDocument()
})

test('a failed load is reported and retryable, not a blank page', async () => {
  api.listNodes.mockRejectedValueOnce(new Error('network down'))
  render(<BrowseNodes onReserve={() => {}} reservingId={null} />)

  expect(await screen.findByText(/could not load the catalogue/i)).toBeInTheDocument()

  api.listNodes.mockResolvedValue({ nodes: [node()] })
  await userEvent.click(screen.getByRole('button', { name: /retry/i }))
  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
})

test('the reserving node\'s button is disabled while its booking is in flight', async () => {
  api.listNodes.mockResolvedValue({ nodes: [node()] })
  render(<BrowseNodes onReserve={() => {}} reservingId="node-1" />)

  expect(await screen.findByRole('button', { name: /reserving/i })).toBeDisabled()
})
