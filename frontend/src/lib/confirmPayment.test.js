import { describe, test, expect, vi, beforeEach } from 'vitest'
import { confirmAndPay, RAZORPAY_HANDLED } from './confirmPayment'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { confirmReservation: vi.fn(), verifyPayment: vi.fn() },
}))

// A minimal stand-in for the real Checkout.js constructor -- captures the
// config it was built with and exposes hooks for a test to simulate
// whatever Razorpay would have called back with (success, dismissal,
// failure), without needing the real script or a live account.
function installFakeRazorpay() {
  const instances = []
  function FakeRazorpay(config) {
    const handlers = {}
    const instance = {
      config,
      opened: false,
      on: (event, cb) => { handlers[event] = cb },
      open: () => { instance.opened = true },
      fireHandler: (response) => config.handler(response),
      fireDismiss: () => config.modal.ondismiss(),
      firePaymentFailed: (resp) => handlers['payment.failed']?.(resp),
    }
    instances.push(instance)
    return instance
  }
  window.Razorpay = FakeRazorpay
  return instances
}

beforeEach(() => {
  vi.clearAllMocks()
  delete window.Razorpay
})

test('when no live gateway is configured, resolves the status directly without touching Razorpay', async () => {
  api.confirmReservation.mockResolvedValue({ requires_payment: false, status: 'confirmed' })
  const status = await confirmAndPay('res-1')
  expect(status).toBe('confirmed')
  expect(window.Razorpay).toBeUndefined()
})

describe('with a live gateway configured', () => {
  function order() {
    return {
      requires_payment: true, order_id: 'order_1', amount_paise: 4300,
      currency: 'INR', razorpay_key_id: 'rzp_test_key',
    }
  }

  test('a successful payment verifies and resolves with the settled status', async () => {
    api.confirmReservation.mockResolvedValue(order())
    api.verifyPayment.mockResolvedValue({ status: 'confirmed' })
    const instances = installFakeRazorpay()

    const promise = confirmAndPay('res-1', { description: 'My Booking' })
    await vi.waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0].opened).toBe(true)
    expect(instances[0].config.description).toBe('My Booking')

    instances[0].fireHandler({
      razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig_1',
    })

    await expect(promise).resolves.toBe('confirmed')
    expect(api.verifyPayment).toHaveBeenCalledWith('res-1', {
      razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig_1',
    })
  })

  test('dismissing the modal reports "Payment cancelled." and rejects with the sentinel', async () => {
    api.confirmReservation.mockResolvedValue(order())
    const onError = vi.fn()
    const instances = installFakeRazorpay()

    const promise = confirmAndPay('res-1', { onError })
    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].fireDismiss()

    await expect(promise).rejects.toThrow(RAZORPAY_HANDLED)
    expect(onError).toHaveBeenCalledWith('Payment cancelled.')
  })

  test('a payment.failed event reports the gateway\'s own description and rejects with the sentinel', async () => {
    api.confirmReservation.mockResolvedValue(order())
    const onError = vi.fn()
    const instances = installFakeRazorpay()

    const promise = confirmAndPay('res-1', { onError })
    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].firePaymentFailed({ error: { description: 'Card declined' } })

    await expect(promise).rejects.toThrow(RAZORPAY_HANDLED)
    expect(onError).toHaveBeenCalledWith('Card declined')
  })

  test('a rejected signature verification is reported and rejects with the sentinel, not a duplicate message', async () => {
    api.confirmReservation.mockResolvedValue(order())
    api.verifyPayment.mockRejectedValue(new Error('invalid signature'))
    const onError = vi.fn()
    const instances = installFakeRazorpay()

    const promise = confirmAndPay('res-1', { onError })
    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].fireHandler({
      razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'bad_sig',
    })

    await expect(promise).rejects.toThrow(RAZORPAY_HANDLED)
    expect(onError).toHaveBeenCalledWith('invalid signature')
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
