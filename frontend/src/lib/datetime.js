// Shared with SearchForm.jsx and ProviderDashboard.jsx's availability form
// -- both feed a JS Date into an <input type="datetime-local"> and later
// read it back with `new Date(el.value)`. A real, live-caught bug (found
// by e2e/tests/golden-path.spec.js running in a non-UTC timezone):
// toISOString() always returns UTC wall-clock time, but datetime-local
// both DISPLAYS and PARSES its value as LOCAL time. Feeding a UTC-labeled
// string into it silently shifts whatever window is built from it by the
// browser's UTC offset -- correct only for users in UTC. Format from the
// local getters instead so what's displayed and what's submitted actually
// agree, in every form that needs this, not just the one that happened to
// get caught first.
export function toDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
