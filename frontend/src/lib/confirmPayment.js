import { api } from '../api'

// A sentinel, not a real error message -- see confirmAndPay's callers for
// why a caller must special-case it rather than showing it as an error:
// the Razorpay-facing branches below already reported something
// user-readable through onError before rejecting with this.
export const RAZORPAY_HANDLED = '__razorpay_already_handled__'

// Loads Checkout.js on demand rather than unconditionally in index.html:
// most page views never reach a payment, and this keeps the no-live-gateway
// path (the one actually exercised by every automated test in this project)
// from depending on a third-party script at all. Shared across every caller
// so the script is fetched once regardless of how many reservations end up
// going through Razorpay in the same session (a solo booking, a
// verification pair, a dispute tiebreaker).
let checkoutScriptPromise = null
function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay)
  if (!checkoutScriptPromise) {
    checkoutScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => resolve(window.Razorpay)
      script.onerror = () => reject(new Error('failed to load the Razorpay Checkout script'))
      document.body.appendChild(script)
    })
  }
  return checkoutScriptPromise
}

// UNVERIFIED AGAINST A LIVE RAZORPAY ACCOUNT -- this project has no
// Razorpay credentials (see backend/src/payments/razorpay.js's file header
// for why: creating a merchant account isn't something that can be done on
// someone else's behalf). Written correctly against Razorpay's documented
// Checkout.js integration; the backend half of this contract (order
// creation, signature verification, the compensating refund if the node
// turns out unreachable after payment) IS tested for real, against a fake
// gateway that speaks the identical wire protocol -- see
// backend/test/payment-flow.test.js.
//
// Confirms a reservation and, if a live gateway is configured on the
// backend, drives the Checkout modal to completion. Resolves with the
// final status ('confirmed') either way; throws a real Error the caller
// should surface, EXCEPT when the message is RAZORPAY_HANDLED, meaning
// onError below already reported something specific (payment failed,
// modal dismissed, signature rejected) and the generic message would just
// duplicate it.
export async function confirmAndPay(reservationId, { description, onError } = {}) {
  const r = await api.confirmReservation(reservationId)
  if (!r.requires_payment) return r.status

  const Razorpay = await loadRazorpayCheckout()
  return new Promise((resolve, reject) => {
    const rzp = new Razorpay({
      key: r.razorpay_key_id,
      amount: r.amount_paise,
      currency: r.currency,
      order_id: r.order_id,
      name: 'NODEVA',
      description: description ?? `Reservation ${reservationId.slice(0, 8)}`,
      handler: async (response) => {
        try {
          const result = await api.verifyPayment(reservationId, {
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          })
          resolve(result.status)
        } catch (e) {
          onError?.(e.message)
          reject(new Error(RAZORPAY_HANDLED))
        }
      },
      modal: {
        ondismiss: () => {
          onError?.('Payment cancelled.')
          reject(new Error(RAZORPAY_HANDLED))
        },
      },
      theme: { color: '#047857' },
    })
    rzp.on('payment.failed', (resp) => {
      onError?.(resp.error?.description ?? 'Payment failed.')
      reject(new Error(RAZORPAY_HANDLED))
    })
    rzp.open()
  })
}
