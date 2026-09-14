import { useState } from 'react'

const MODES = [
  { value: 'cheapest', label: 'Cheapest' },
  { value: 'best_value', label: 'Best Value' },
  { value: 'fastest', label: 'Fastest' },
]

// Requirement-based search, not a GPU-model picker -- the marketplace's core
// UX decision (master brief §7). The user states what they need; the
// scheduler decides which node fits.
export default function SearchForm({ onSearch, busy }) {
  const now = new Date()
  const in1h = new Date(now.getTime() + 60 * 60 * 1000)
  const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000)
  // A real, live-caught bug (found by e2e/tests/golden-path.spec.js running
  // in a non-UTC timezone): toISOString() always returns UTC wall-clock
  // time, but an <input type="datetime-local"> both DISPLAYS and, when read
  // back via `new Date(el.value)`, PARSES its value as LOCAL time. Feeding
  // a UTC-labeled string into it silently shifted the default search
  // window by the browser's UTC offset -- correct only for users in UTC,
  // wrong (here, ~5.5 hours early) everywhere else. Format from the local
  // getters instead so what's displayed and what's submitted actually agree.
  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const [vram, setVram] = useState(20)
  const [cpu, setCpu] = useState(8)
  const [ram, setRam] = useState(16)
  const [start, setStart] = useState(fmt(in1h))
  const [end, setEnd] = useState(fmt(in2h))
  const [budget, setBudget] = useState(50)
  const [mode, setMode] = useState('best_value')

  function submit(e) {
    e.preventDefault()
    const startsAt = new Date(start).getTime()
    const endsAt = new Date(end).getTime()
    onSearch({
      min_vram_mb: vram * 1024,
      min_cpu_cores: cpu,
      min_ram_mb: ram * 1024,
      max_price_paise_hr: budget * 100,
      starts_at: startsAt,
      ends_at: endsAt,
      mode,
      // kept for display purposes by the parent, not sent to the API
      _startsAtLocal: start,
      _endsAtLocal: end,
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm md:grid-cols-2">
      <h2 className="col-span-full text-lg font-semibold text-neutral-800">Find Compute</h2>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-600">GPU Memory (GB+)</span>
        <input type="number" min={1} value={vram} onChange={(e) => setVram(+e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-600">CPU (cores+)</span>
        <input type="number" min={1} value={cpu} onChange={(e) => setCpu(+e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-600">RAM (GB+)</span>
        <input type="number" min={1} value={ram} onChange={(e) => setRam(+e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-600">Maximum Budget (₹/hr)</span>
        <div className="flex items-center gap-2">
          <input type="range" min={5} max={300} value={budget}
            onChange={(e) => setBudget(+e.target.value)} className="flex-1" />
          <span className="w-16 text-right tabular-nums">₹{budget}/hr</span>
        </div>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-600">Start</span>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-600">End</span>
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1" />
      </label>

      <fieldset className="col-span-full flex gap-4 text-sm">
        <legend className="mb-1 font-medium text-neutral-600">Optimization</legend>
        {MODES.map((m) => (
          <label key={m.value} className="flex items-center gap-1.5">
            <input type="radio" name="mode" value={m.value} checked={mode === m.value}
              onChange={() => setMode(m.value)} />
            {m.label}
          </label>
        ))}
      </fieldset>

      <button disabled={busy}
        className="col-span-full rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
        {busy ? 'Searching…' : 'Find Compute'}
      </button>
    </form>
  )
}
