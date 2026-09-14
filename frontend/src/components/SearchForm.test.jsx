import { test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SearchForm from './SearchForm'

// Regression test for a real, live-caught bug (found by
// e2e/tests/golden-path.spec.js running in a non-UTC timezone): the
// default Start/End values used to be formatted with toISOString() (UTC
// wall-clock time) but fed into an <input type="datetime-local">, which
// both displays AND parses its value as LOCAL time. In any timezone other
// than UTC this silently shifted the default search window by the
// browser's UTC offset. jsdom (this test's environment) uses the host's
// real timezone, so this genuinely exercises whatever TZ the test runs
// under -- not hardcoded to reproduce IST specifically.
test('the default Start/End values round-trip to roughly now+1h/now+2h regardless of local timezone', () => {
  const before = Date.now()
  render(<SearchForm onSearch={() => {}} busy={false} />)
  const after = Date.now()

  const startInput = screen.getByLabelText(/^Start$/)
  const endInput = screen.getByLabelText(/^End$/)

  // What the component displays, read back exactly as App.jsx's own
  // submit handler does: `new Date(value).getTime()`. If this were still
  // UTC-formatted-but-locally-parsed, the round trip would be off by the
  // timezone offset (5.5h in IST) instead of landing within a few seconds
  // of "now" plus 1h/2h.
  const startMs = new Date(startInput.value).getTime()
  const endMs = new Date(endInput.value).getTime()

  const ONE_HOUR = 3600_000
  const SLACK_MS = 60_000 // render + assertion overhead, generous but nowhere near the 5.5h bug's magnitude
  expect(startMs).toBeGreaterThanOrEqual(before + ONE_HOUR - SLACK_MS)
  expect(startMs).toBeLessThanOrEqual(after + ONE_HOUR + SLACK_MS)
  expect(endMs).toBeGreaterThanOrEqual(before + 2 * ONE_HOUR - SLACK_MS)
  expect(endMs).toBeLessThanOrEqual(after + 2 * ONE_HOUR + SLACK_MS)
})

test('submitting with the untouched defaults sends a starts_at/ends_at pair about an hour apart, close to now', () => {
  const onSearch = vi.fn()
  render(<SearchForm onSearch={onSearch} busy={false} />)
  fireEvent.click(screen.getByRole('button', { name: /find compute/i }))

  expect(onSearch).toHaveBeenCalledTimes(1)
  const req = onSearch.mock.calls[0][0]
  const now = Date.now()
  expect(req.starts_at).toBeGreaterThan(now) // must be in the FUTURE, not hours in the past
  expect(req.ends_at - req.starts_at).toBe(3600_000)
})
