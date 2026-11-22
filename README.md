# zasend-node

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)

Official Node.js client for the [zaSend](https://zasend.com) transactional email API.

zaSend is a developer-focused email delivery service for sending product, auth, billing, notification, and lifecycle emails from your application. This package is a small wrapper around the zaSend REST API for Node.js, Next.js, Express, NestJS, background jobs, and scripts.

Use it to:

- Send transactional email from verified domains
- Send template-based email with variables
- Check message status and events
- Manage suppressions, webhooks, templates, and domains
- Verify zaSend webhook signatures

The client stays close to the raw API. It has no runtime dependencies and uses the built-in `fetch` available in Node 18+.

## Install

```bash
npm install zasend-node
```

## Quick Start

```js
const { ZaSend } = require("zasend-node");

const zasend = new ZaSend(process.env.ZASEND_API_KEY);

const result = await zasend.sendEmail({
  from: "zaSend <noreply@zasend.com>",
  to: "user@example.com",
  subject: "Welcome",
  text: "Thanks for signing up.",
});

console.log(result.message_id);
```

### Which key do I need?

Create API keys on the **API keys** page of the dashboard. Each key has an access level and can be limited to one domain:

| Access | Use it for |
| --- | --- |
| Sending only | Apps that only send: `sendEmail`, `sendBatch`, `getEmail`, `getRateLimits` |
| Agent | Sending plus reading received email (`listInboundMessages`, `getInboundMessage`) |
| Full access | Everything, including domains, templates, webhooks, SMTP passwords and API keys |
| Custom | Pick permissions: send, status, inbound, smtp, templates, suppressions, webhooks, domains |

If a key lacks a permission the call throws an `APIError` with `status` 403 and `missingPermission` (for example `"inbound"`). SMTP passwords (`smtp_live_...`) are for SMTP apps and don't work with this SDK; older domain keys (`dsk_live_...`) can still send.

## Send HTML Email

```js
await zasend.sendEmail({
  from: "Acme <noreply@acme.com>",
  to: "customer@example.com",
  subject: "Your receipt",
  html: "<h1>Thanks for your order</h1><p>Your receipt is attached.</p>",
  text: "Thanks for your order. Your receipt is attached.",
});
```

## Send to Multiple Recipients

```js
await zasend.sendEmail({
  from: "Acme <noreply@acme.com>",
  to: ["one@example.com", "two@example.com"],
  subject: "Product update",
  text: "A new update is available.",
});
```

zaSend returns one queued message per `to` recipient. Suppressed recipients reject the whole request so you can fix the list before sending.

## Batch Send

Up to 100 different emails in one call. A partial failure is not an error: check `failed` and each result's `status`.

```js
const result = await zasend.sendBatch([
  { from: "noreply@yourdomain.com", to: "ann@example.com", template: "welcome", variables: { name: "Ann" } },
  { from: "noreply@yourdomain.com", to: "bob@example.com", subject: "Receipt", text: "Thanks, Bob" },
]);
console.log(result.queued, result.failed, result.results);
```

## Template Send

```js
await zasend.sendTemplateEmail({
  from: "Acme <noreply@acme.com>",
  to: "customer@example.com",
  template: "welcome",
  variables: { name: "Ada" },
});
```

## Next.js / Express Example

```js
const { ZaSend } = require("zasend-node");

const zasend = new ZaSend(process.env.ZASEND_API_KEY);

async function sendSignupEmail(email) {
  return zasend.sendTemplateEmail({
    from: "Acme <noreply@acme.com>",
    to: email,
    template: "welcome",
    variables: { product: "Acme" },
  });
}
```

## Webhook Verification

`verifyWebhookSignatureV2(rawBody, secret, req.headers["x-zasend-signature-v2"])` also checks the timestamp and rejects deliveries older than 5 minutes. Prefer it over the older check below.

zaSend signs webhook payloads with HMAC-SHA256. Verify the raw request body before trusting webhook data.

For replay protection, zaSend also sends `X-zaSend-Timestamp` and `X-zaSend-Signature-V2: t=<unix>,v1=<hex>`, where `v1` is HMAC-SHA256 of `"<t>.<raw body>"` with the same secret. Reject deliveries older than a few minutes.

```js
const { verifyWebhookSignature } = require("zasend-node");

const ok = verifyWebhookSignature(
  request.rawBody,
  process.env.ZASEND_WEBHOOK_SECRET,
  request.headers["x-zasend-signature"]
);
```

## API Methods

| Method | Description |
| --- | --- |
| `sendEmail(message)` | Send direct content or a template email |
| `sendTemplateEmail(options)` | Convenience wrapper for template sends |
| `getEmail(messageId)` | Fetch email status and events |
| `getRateLimits()` | Fetch daily usage and limits |
| `listDomains()` / `addDomain(domain)` / `verifyDomain(id)` / `deleteDomain(id)` | Manage sending domains |
| `listSuppressions(options)` / `addSuppression(email, options)` / `deleteSuppression(id)` | Manage suppression list entries |
| `listWebhooks()` / `createWebhook(url, events)` / `deleteWebhook(id)` | Manage signed delivery webhooks |
| `listTemplates()` / `createTemplate(template)` / `getTemplate(id)` / `updateTemplate(id, template)` / `deleteTemplate(id)` | Manage email templates |
| `listInboundMessages({ limit, domain, to, unread })` / `getInboundMessage(id)` | Read received email |
| `listSmtpPasswords({ domain })` / `createSmtpPassword(domain, { name })` / `deleteSmtpPassword(id)` | SMTP passwords for SMTP apps (the new password is returned once) |
| `listApiKeys()` / `createApiKey(name, { access, domain })` / `revokeApiKey(id)` | Manage API keys (needs Full access) |

## Error Handling

```js
const { APIError, RateLimitError, ValidationError, ZaSend } = require("zasend-node");

try {
  await new ZaSend(process.env.ZASEND_API_KEY).sendEmail({
    from: "Acme <noreply@acme.com>",
    to: "user@example.com",
    subject: "Hello",
    text: "Body",
  });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log("Rate limited:", error.message);
  } else if (error instanceof ValidationError) {
    console.log("Invalid request:", error.message);
  } else if (error instanceof APIError && error.missingPermission) {
    console.log("This key needs the permission:", error.missingPermission);
  } else if (error instanceof APIError) {
    console.log("zaSend API error:", error.message);
  } else {
    throw error;
  }
}
```

## Links

- Website: [zasend.com](https://zasend.com)
- API documentation: [zasend.com/docs](https://zasend.com/docs)
- Source: [GitHub](https://github.com/lr2bmail/zasend-node)

## License

MIT

## Attachments

Attachments are enabled per account. Build them from files and send:

```js
const { ZaSend, attachmentFromFile } = require("zasend-node");

const client = new ZaSend(process.env.ZASEND_API_KEY, { timeout: 30000 });
await client.sendEmail(
  {
    from: "billing@yourdomain.com",
    to: "customer@example.com",
    subject: "Your invoice",
    text: "Invoice attached.",
    attachments: [attachmentFromFile("invoice.pdf")],
  },
  { idempotencyKey: "order-1042" }, // a retry within 24h returns the first result
);
```
