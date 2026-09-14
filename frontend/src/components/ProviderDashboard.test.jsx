import { test, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProviderDashboard from './ProviderDashboard'

vi.mock('../api', () => ({
  api: {
    providerDashboard: vi.fn(),
    becomeProvider: vi.fn(),
    enrollNode: vi.fn(),
  },
}))
import { api } from '../api'

function dashboardWithNoNodes() {
  return {
    reputation: { jobs_total: 0, reliability: null },
    earnings: { today_paise: 0, week_paise: 0, month_paise: 0, available_paise: 0 },
    nodes: [],
    disputes: [],
  }
}

// Regression test for a real bug: the enroll-a-node form used to default
// GPU model/VRAM/cores/RAM/price to plausible-looking real values ('RTX
// 4090', 24, 16, 32, 43) instead of empty fields with a placeholder --
// meaning a provider could click "Enroll this machine" without typing
// anything and register a node with fabricated specs. That's exactly the
// declared-vs-actual mismatch api/server.js's checkHardwareMismatch exists
// to catch, except the form itself was inviting it rather than provider
// dishonesty causing it.
test('the enroll form starts empty, not pre-filled with plausible example values', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)

  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  expect(screen.getByLabelText('GPU model')).toHaveValue('')
  expect(screen.getByLabelText('VRAM (GB)')).toHaveValue(null) // number input, empty
  expect(screen.getByLabelText('CPU cores')).toHaveValue(null)
  expect(screen.getByLabelText('RAM (GB)')).toHaveValue(null)
  expect(screen.getByLabelText('Price (₹/hr)')).toHaveValue(null)
})

test('submitting without filling in the numeric fields is blocked, not silently sent with garbage', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  fireEvent.change(screen.getByPlaceholderText('public key (64 hex characters)'), {
    target: { value: 'a'.repeat(64) },
  })
  fireEvent.click(screen.getByRole('button', { name: /enroll this machine/i }))

  // The browser's native `required` validation blocks the submit -- api.enrollNode
  // must never be called with the fields left empty.
  await new Promise((r) => setTimeout(r, 50))
  expect(api.enrollNode).not.toHaveBeenCalled()
})

test('a fully filled-in form submits the exact typed values, correctly converted to the API shape', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  api.enrollNode.mockResolvedValue({ node_id: 'new-node' })
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  fireEvent.change(screen.getByPlaceholderText('public key (64 hex characters)'), { target: { value: 'b'.repeat(64) } })
  fireEvent.change(screen.getByLabelText('GPU model'), { target: { value: 'RTX 3080' } })
  fireEvent.change(screen.getByLabelText('VRAM (GB)'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('CPU cores'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText('RAM (GB)'), { target: { value: '16' } })
  fireEvent.change(screen.getByLabelText('Price (₹/hr)'), { target: { value: '25.5' } })
  fireEvent.click(screen.getByRole('button', { name: /enroll this machine/i }))

  await waitFor(() => expect(api.enrollNode).toHaveBeenCalledTimes(1))
  expect(api.enrollNode).toHaveBeenCalledWith({
    public_key_hex: 'b'.repeat(64),
    gpu_model: 'RTX 3080',
    gpu_vram_mb: 10 * 1024,
    cpu_cores: 8,
    ram_mb: 16 * 1024,
    price_paise_hr: 2550,
  })
})
