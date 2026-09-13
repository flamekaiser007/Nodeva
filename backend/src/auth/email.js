// Outbound email. Unlike Razorpay (docs/payment-architecture.md), this one
// genuinely CAN be verified end to end without a persistent business
// account: nodemailer's Ethereal test accounts are created on demand via a
// live API call, no signup required, and a message sent through one can be
// read back via its own preview URL -- see test/email.test.js, which sends
// a real email over real SMTP and confirms it. Production SMTP (a real
// provider's host/port/credentials) is the same code path, just different
// environment variables.

import nodemailer from 'nodemailer';

export class SmtpEmailSender {
  constructor(transportOptions, { from = 'NODEVA <noreply@nodeva.local>' } = {}) {
    this._transporter = nodemailer.createTransport(transportOptions);
    this._from = from;
  }

  async send({ to, subject, text }) {
    return this._transporter.sendMail({ from: this._from, to, subject, text });
  }
}

/** Stand-in for when no SMTP is configured -- logs the email instead of
 * sending it, loudly, the same posture as payments/razorpay.js's
 * UnconfiguredGateway. In practice this means the reset LINK ends up in the
 * server's own log, which is enough to develop and demo the flow without
 * any mail server at all, but is obviously not what a real deployment wants. */
export class ConsoleEmailSender {
  async send({ to, subject, text }) {
    console.warn(
      `[email] no SMTP configured -- would have sent to ${to}:\n` +
      `  subject: ${subject}\n` +
      `  body:\n${text.split('\n').map((l) => '    ' + l).join('\n')}`);
    return { messageId: 'console-only', accepted: [to] };
  }
}

export function createEmailSenderFromEnv(env = process.env) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = env;
  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
    return new SmtpEmailSender(
      { host: SMTP_HOST, port: Number(SMTP_PORT), secure: Number(SMTP_PORT) === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS } },
      { from: SMTP_FROM || undefined },
    );
  }
  return new ConsoleEmailSender();
}

export function resetPasswordEmailBody(resetUrl) {
  return (
    `Someone (hopefully you) asked to reset the password on your NODEVA account.\n\n` +
    `Reset it here: ${resetUrl}\n\n` +
    `This link expires in 1 hour. If you didn't request this, you can ignore this email --\n` +
    `your password will not change unless you click the link above.`
  );
}
