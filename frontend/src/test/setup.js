import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library doesn't unmount components between tests on its own --
// without this, a later test's queries can match DOM left over from an
// earlier one, which is exactly the kind of false pass that would hide a
// real bug (e.g. two tests both matching the same stale "Confirmed" text).
afterEach(() => {
  cleanup()
})
