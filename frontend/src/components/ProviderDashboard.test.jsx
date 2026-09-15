import { test, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProviderDashboard from './ProviderDashboard'

vi.mock('../api', () => ({
  api: {
    providerDashboard: vi.fn(),
    becomeProvider: vi.fn(),
    enrollNode: vi.fn(),
    retireNode: vi.fn(),
    addAvailability: vi.fn(),
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

// --- availability window folded into enrollment itself ------------------
// Regression coverage: a node with zero node_availability rows never
// appears in search no matter what else matches. Availability used to be
// a separate step a provider had to remember to do afterward (the node
// card's own AvailabilityForm); it's now part of enrollment itself so a
// node is actually bookable the moment it's created, not silently inert
// until someone notices.

test('enrolling a node also sets its availability window with the SAME node_id enrollNode returned', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  api.enrollNode.mockResolvedValue({ node_id: 'brand-new-node' })
  api.addAvailability.mockResolvedValue({})
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: 'f'.repeat(64) } })
  fireEvent.change(screen.getByLabelText('GPU model'), { target: { value: 'RTX 3080' } })
  fireEvent.change(screen.getByLabelText('VRAM (GB)'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('CPU cores'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText('RAM (GB)'), { target: { value: '16' } })
  fireEvent.change(screen.getByLabelText('Price (₹/hr)'), { target: { value: '25' } })
  fireEvent.click(screen.getByRole('button', { name: /enroll this machine/i }))

  await waitFor(() => expect(api.addAvailability).toHaveBeenCalledTimes(1))
  const [nodeId, start, end] = api.addAvailability.mock.calls[0]
  expect(nodeId).toBe('brand-new-node')
  expect(new Date(end).getTime()).toBeGreaterThan(new Date(start).getTime())
})

test('a sensible default availability window is pre-filled -- not left empty or a plausible fake value', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  const availabilityStart = screen.getByLabelText('Start')
  const now = Date.now()
  const startMs = new Date(availabilityStart.value).getTime()
  // Defaults to "starting in about an hour" -- close to now, not some far
  // future placeholder a provider would have to remember to fix.
  expect(startMs).toBeGreaterThan(now)
  expect(startMs).toBeLessThan(now + 2 * 60 * 60 * 1000)
})

test('enrollment succeeds even if setting availability afterward fails -- the node is not silently lost', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithNoNodes())
  api.enrollNode.mockResolvedValue({ node_id: 'partial-node' })
  api.addAvailability.mockRejectedValue(new Error('window_end must be after window_start'))
  render(<ProviderDashboard />)
  fireEvent.click(await screen.findByRole('button', { name: /enroll a node/i }))

  fireEvent.change(screen.getByPlaceholderText("paste the command's output here"), { target: { value: 'g'.repeat(64) } })
  fireEvent.change(screen.getByLabelText('GPU model'), { target: { value: 'RTX 3080' } })
  fireEvent.change(screen.getByLabelText('VRAM (GB)'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('CPU cores'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText('RAM (GB)'), { target: { value: '16' } })
  fireEvent.change(screen.getByLabelText('Price (₹/hr)'), { target: { value: '25' } })
  fireEvent.click(screen.getByRole('button', { name: /enroll this machine/i }))

  // The real, already-created node is surfaced honestly -- not reported
  // as if enrollment itself failed -- and the form stays open (rather
  // than being force-closed, which would destroy this exact message
  // before anyone could read it).
  expect(await screen.findByText(/node enrolled, but setting its availability failed/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /enroll this machine/i })).toBeInTheDocument()
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

// --- surfacing node_id + the run command for an offline node -----------
// Regression coverage for a real gap: node_id was used internally (React
// key, the retire API call) but never shown anywhere, even though it's a
// required argument to actually run the worker (worker/run_worker.py). A
// provider who enrolled a node had no way to discover the one thing they
// needed to bring it online.

test('an offline node shows its node_id and the exact run command', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithOneNode({ online: false, status: 'enrolling' }))
  render(<ProviderDashboard />)

  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
  expect(screen.getByText(/node-1/)).toBeInTheDocument()
  expect(screen.getByText(/run_worker\.py/)).toBeInTheDocument()
  expect(screen.getByText(/--price-paise-hr 4300/)).toBeInTheDocument()
})

test('an online node does not show the offline run-command hint', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithOneNode({
    online: true, heartbeat: { gpu: null, live_reservations: 0 },
  }))
  render(<ProviderDashboard />)

  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
  expect(screen.queryByText(/run_worker\.py/)).not.toBeInTheDocument()
})

test('an offline node with a STALE heartbeat from before it disconnected still shows the run command, not the CPU-only text', async () => {
  // Real, live-caught bug: the backend keeps a node's last heartbeat in
  // memory forever (api/server.js's `heartbeats` map is never cleared on
  // disconnect), so a node that had ever reported in before going offline
  // still arrives here with a non-null `heartbeat`, even though `online`
  // is false. The branch order used to check `heartbeat` before `online`,
  // so this exact node fell into the CPU-only branch forever instead of
  // ever showing the run command.
  api.providerDashboard.mockResolvedValue(dashboardWithOneNode({
    online: false, heartbeat: { gpu: null, live_reservations: 0 },
  }))
  render(<ProviderDashboard />)

  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
  expect(screen.getByText(/run_worker\.py/)).toBeInTheDocument()
  expect(screen.queryByText(/CPU-only node/)).not.toBeInTheDocument()
})

// --- availability window form -------------------------------------------
// Regression coverage for a real, significant gap: api.addAvailability
// existed in api.js but nothing in the UI ever called it. A node with zero
// node_availability rows can never appear in search results
// (searchCandidates joins against it), no matter how well it otherwise
// matches -- there was simply no way for a provider to make a node
// bookable through the app at all.

test('every node card shows an availability form, and submitting it calls addAvailability', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithOneNode())
  api.addAvailability.mockResolvedValue({})
  render(<ProviderDashboard />)

  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /add window/i }))

  await waitFor(() => expect(api.addAvailability).toHaveBeenCalledTimes(1))
  const [nodeId, start, end] = api.addAvailability.mock.calls[0]
  assert_iso(start); assert_iso(end)
  expect(nodeId).toBe('node-1')
  expect(await screen.findByText(/added -- bookable from/i)).toBeInTheDocument()
})

function assert_iso(value) {
  expect(() => new Date(value).toISOString()).not.toThrow()
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
}

test('a failed addAvailability call shows the real error, not a silent failure', async () => {
  api.providerDashboard.mockResolvedValue(dashboardWithOneNode())
  api.addAvailability.mockRejectedValue(new Error('window_end must be after window_start'))
  render(<ProviderDashboard />)

  expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /add window/i }))

  expect(await screen.findByText(/window_end must be after window_start/i)).toBeInTheDocument()
})
