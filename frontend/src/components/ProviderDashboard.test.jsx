import { test, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProviderDashboard from './ProviderDashboard'

vi.mock('../api', () => ({
  api: {
    providerDashboard: vi.fn(),
    becomeProvider: vi.fn(),
    enrollNode: vi.fn(),
    retireNode: vi.fn(),
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

  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), {
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

  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: 'b'.repeat(64) } })
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

// Regression coverage for the follow-up gap: pasting a bare hex string
// used to be the ONLY thing this field accepted, leaving GPU
// model/VRAM/cores/RAM to be typed in by hand and guessed. The CLI
// snippet now prints a JSON blob (worker/nodeva_worker/hardware.py's
// describe_this_machine) instead of a bare hex string; pasting the WHOLE
// blob should auto-fill everything it detected.
test('pasting the JSON blob from the CLI snippet auto-fills the detected fields', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  const blob = JSON.stringify({
    public_key_hex: 'c'.repeat(64),
    gpu_model: 'NVIDIA GeForce RTX 4090',
    gpu_vram_gb: 24,
    cpu_cores: 16,
    ram_gb: 32,
  })
  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: blob } })

  // The field itself collapses down to just the extracted public key --
  // that's what actually gets submitted, not the raw JSON text.
  expect(screen.getByPlaceholderText("paste the command's output here")).toHaveValue('c'.repeat(64))
  expect(screen.getByLabelText('GPU model')).toHaveValue('NVIDIA GeForce RTX 4090')
  expect(screen.getByLabelText('VRAM (GB)')).toHaveValue(24)
  expect(screen.getByLabelText('CPU cores')).toHaveValue(16)
  expect(screen.getByLabelText('RAM (GB)')).toHaveValue(32)
  expect(screen.getByText(/detected from your machine/i)).toBeInTheDocument()
})

test('pasting a JSON blob for a CPU-only node (null GPU fields) leaves GPU fields for manual entry', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  const blob = JSON.stringify({
    public_key_hex: 'd'.repeat(64),
    gpu_model: null, gpu_vram_gb: null, // NoGpu, per hardware.py's honest-unknown posture
    cpu_cores: 8, ram_gb: 16,
  })
  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: blob } })

  expect(screen.getByLabelText('GPU model')).toHaveValue('') // still empty -- nothing to auto-fill, not a fabricated value
  expect(screen.getByLabelText('VRAM (GB)')).toHaveValue(null)
  expect(screen.getByLabelText('CPU cores')).toHaveValue(8)
  expect(screen.getByLabelText('RAM (GB)')).toHaveValue(16)
})

test('pasting a bare hex string (not JSON) still works exactly as before', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: 'e'.repeat(64) } })

  expect(screen.getByPlaceholderText("paste the command's output here")).toHaveValue('e'.repeat(64))
  expect(screen.getByLabelText('GPU model')).toHaveValue('') // nothing to auto-fill from a bare string
  expect(screen.queryByText(/detected from your machine/i)).not.toBeInTheDocument()
})

// --- removing a machine -------------------------------------------------

function dashboardWithOneNode(overrides = {}) {
  return {
    reputation: { jobs_total: 0, reliability: null },
    earnings: { today_paise: 0, week_paise: 0, month_paise: 0, available_paise: 0 },
    disputes: [],
    nodes: [{
      node_id: 'node-1', gpu_model: 'RTX 4090', gpu_vram_mb: 24576, cpu_cores: 16,
      ram_mb: 32768, price_paise_hr: 4300, status: 'online', online: true,
      heartbeat: null, hardware_mismatch: null, ...overrides,
    }],
  }
}

test('clicking Remove asks for confirmation, then calls retireNode and refreshes the dashboard', async () => {
  api.providerDashboard
    .mockResolvedValueOnce(dashboardWithOneNode())
    .mockResolvedValueOnce(dashboardWithNoNodes()) // the refresh after a successful retire
  api.retireNode.mockResolvedValue({ ok: true })
  vi.spyOn(window, 'confirm').mockReturnValue(true)

  render(<ProviderDashboard />)
  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /remove/i }))

  expect(window.confirm).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(api.retireNode).toHaveBeenCalledWith('node-1'))
  // The onRetired callback re-fetches the dashboard, which now has no nodes.
  await waitFor(() => expect(screen.queryByText('RTX 4090')).not.toBeInTheDocument())
})

test('declining the confirmation does not call retireNode', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithOneNode())
  vi.spyOn(window, 'confirm').mockReturnValue(false)

  render(<ProviderDashboard />)
  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /remove/i }))

  expect(api.retireNode).not.toHaveBeenCalled()
  expect(screen.getByText('RTX 4090')).toBeInTheDocument() // still there
})

test('a refused retire (409, e.g. a live reservation) shows the real error, not a silent failure', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithOneNode())
  api.retireNode.mockRejectedValue(Object.assign(new Error('node has a live reservation; wait for it to settle first'), { status: 409 }))
  vi.spyOn(window, 'confirm').mockReturnValue(true)

  render(<ProviderDashboard />)
  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /remove/i }))

  expect(await screen.findByText(/live reservation/i)).toBeInTheDocument()
  expect(screen.getByText('RTX 4090')).toBeInTheDocument() // the node is still listed -- nothing was removed
})

// --- no-GPU-detected messaging ------------------------------------------
// Regression coverage: hardware.py's describe_this_machine() correctly
// reports gpu_model: null on a CPU-only machine (or a Mac/AMD card
// nvidia-smi can't see) -- a real user's own Apple Silicon MacBook Air hit
// this and had no idea why GPU model stayed blank, then submitted VRAM: 0
// and got a raw "internal_error" back (fixed server-side too; see
// dashboard.test.js's gpu_vram_mb validation tests).

test('pasting a blob with gpu_model: null shows a clear explanation, not a silent blank', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  const blob = JSON.stringify({
    public_key_hex: 'f'.repeat(64),
    gpu_model: null, gpu_vram_gb: null, cpu_cores: 8, ram_gb: 8,
  })
  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: blob } })

  expect(screen.getByText(/no nvidia gpu was detected/i)).toBeInTheDocument()
})

test('the VRAM/CPU/RAM/price fields reject 0 client-side (min=1), so a CPU-only paste cannot be submitted with a fabricated 0', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  expect(screen.getByLabelText('VRAM (GB)')).toHaveAttribute('min', '1')
  expect(screen.getByLabelText('CPU cores')).toHaveAttribute('min', '1')
  expect(screen.getByLabelText('RAM (GB)')).toHaveAttribute('min', '1')
  expect(screen.getByLabelText('Price (₹/hr)')).toHaveAttribute('min', '1')
})

test('a bare hex paste (no JSON) does not show the no-GPU warning -- nothing was actually detected either way', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: 'a'.repeat(64) } })

  expect(screen.queryByText(/no nvidia gpu was detected/i)).not.toBeInTheDocument()
})
