// Real-browser proof of the golden path: sign up, search, reserve, confirm
// & pay (no live gateway configured, so this resolves directly), submit a
// job, and watch a REAL Docker container's real stdout show up in the UI.
// Everything below this test is either Vitest component tests (mocked
// ../api) or curl-level checks (scripts/e2e_demo.sh) -- this is the one
// place the actual rendered DOM, real clicks, and a real running backend +
// worker + Postgres + Docker container are all exercised together.
import { test, expect } from '@playwright/test';

test('sign up, reserve a real node, pay, run a real job, and see real output', async ({ page }) => {
  const email = `e2e-buyer-${Date.now()}@nodeva.test`;

  await page.goto('/');

  // --- sign up -----------------------------------------------------------
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByPlaceholder('email').fill(email);
  await page.getByPlaceholder('display name').fill('E2E Buyer');
  await page.getByPlaceholder('password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByText(`Signed in as`)).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  // --- search (the form's own defaults already match the seeded node) ----
  await page.getByRole('button', { name: 'Find Compute' }).click();
  await expect(page.getByText('RTX 4090 (E2E)')).toBeVisible({ timeout: 10_000 });

  // --- reserve -------------------------------------------------------------
  await page.getByRole('button', { name: 'Reserve' }).click();
  await expect(page.getByText('Held — awaiting payment')).toBeVisible({ timeout: 10_000 });

  // --- confirm & pay (no live Razorpay configured -- resolves directly) ---
  await page.getByRole('button', { name: /Confirm & Pay/ }).click();
  await expect(page.getByText('Confirmed — ready to run a job')).toBeVisible({ timeout: 10_000 });

  // --- submit a real job against the real worker/Docker -------------------
  // Image and command are already prefilled with sensible defaults
  // (ActiveReservation.jsx) -- alpine:3.20 running a real echo.
  await page.getByRole('button', { name: 'Submit Job' }).click();
  await expect(page.getByText(/Job .+ — running/)).toBeVisible({ timeout: 10_000 });

  // A real container pull-and-run, not a mock -- generous timeout for a
  // cold Docker start on whatever machine runs this.
  await expect(page.getByText(/Job .+ — succeeded/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('pre')).toContainText('hello from your reserved GPU node');

  // The reservation settles server-side once JOB_RESULT lands, and the app
  // returns to the search screen ~500ms after the job goes terminal (see
  // ActiveReservation.jsx's onSettled delay).
  await expect(page.getByRole('button', { name: 'Find Compute' })).toBeVisible({ timeout: 5_000 });
});

test('a wrong password is rejected with a real 401 surfaced in the UI', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('email').fill('nobody-with-this-email@nodeva.test');
  await page.getByPlaceholder('password').fill('whatever this is not right');
  // Two elements are named exactly "Log in" in the default (login) mode:
  // the mode tab and the form's own submit button -- the submit button is
  // the second one in DOM order.
  await page.getByRole('button', { name: 'Log in' }).nth(1).click();
  await expect(page.getByText('invalid email or password')).toBeVisible();
});

test('searching outside the node\'s availability window returns the real empty state', async ({ page }) => {
  await page.goto('/');
  const email = `e2e-buyer-empty-${Date.now()}@nodeva.test`;
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByPlaceholder('email').fill(email);
  await page.getByPlaceholder('display name').fill('E2E Buyer Empty');
  await page.getByPlaceholder('password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();

  // Push the search window a full year out, well past the node's
  // 1-day availability window seeded by run_e2e.sh.
  const farStart = page.getByLabel('Start');
  const farEnd = page.getByLabel('End');
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const isoLocal = (d) => d.toISOString().slice(0, 16);
  await farStart.fill(isoLocal(future));
  await farEnd.fill(isoLocal(new Date(future.getTime() + 3600 * 1000)));

  await page.getByRole('button', { name: 'Find Compute' }).click();
  await expect(page.getByText('No provider currently matches those requirements')).toBeVisible({ timeout: 10_000 });
});
