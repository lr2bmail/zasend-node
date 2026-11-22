const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  APIError,
  RateLimitError,
  ValidationError,
  ZaSend,
  ZaSendError,
  verifyWebhookSignature,
  verifyWebhookSignatureV2,
} = require("../src");

function fakeResponse(body, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    statusText: options.statusText || "OK",
    async json() {
      if (body instanceof Error) {
        throw body;
      }
      return body;
    },
  };
}

test("sendEmail posts JSON with bearer auth", async () => {
  let requestedUrl;
  let requestedInit;
  const client = new ZaSend("key", {
    baseUrl: "https://example.test/api/v1",
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return fakeResponse({ success: true, message_id: "msg_123", status: "queued" });
    },
  });

  const result = await client.sendEmail({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Hello",
    text: "Body",
  });

  assert.equal(requestedUrl, "https://example.test/api/v1/emails/send");
  assert.equal(requestedInit.method, "POST");
  assert.equal(requestedInit.headers.Authorization, "Bearer key");
  assert.equal(JSON.parse(requestedInit.body).subject, "Hello");
  assert.equal(result.message_id, "msg_123");
});

test("listSuppressions sends query parameters", async () => {
  let requestedUrl;
  const client = new ZaSend("key", {
    baseUrl: "https://example.test/api/v1",
    fetch: async (url) => {
      requestedUrl = url;
      return fakeResponse({ suppressions: [] });
    },
  });

  await client.listSuppressions({ page: 2, per_page: 100, reason: "bounce" });

  assert.equal(requestedUrl, "https://example.test/api/v1/suppressions?page=2&per_page=100&reason=bounce");
});

test("raises typed errors", async () => {
  const rateLimited = new ZaSend("key", {
    fetch: async () => fakeResponse({ message: "slow down" }, { ok: false, status: 429 }),
  });
  await assert.rejects(() => rateLimited.getRateLimits(), RateLimitError);

  const invalid = new ZaSend("key", {
    fetch: async () => fakeResponse({ message: "bad email" }, { ok: false, status: 422 }),
  });
  await assert.rejects(() => invalid.sendEmail({}), ValidationError);

  const missing = new ZaSend("key", {
    fetch: async () => fakeResponse({ message: "missing" }, { ok: false, status: 404 }),
  });
  await assert.rejects(() => missing.getEmail("missing"), APIError);
});

test("delete methods return null for 204", async () => {
  const client = new ZaSend("key", {
    fetch: async () => ({ ok: true, status: 204, async json() { throw new Error("none"); } }),
  });

  assert.equal(await client.deleteWebhook("hook_123"), null);
});

test("webhook signature verification accepts valid signatures", () => {
  const crypto = require("node:crypto");
  const body = JSON.stringify({ event: "accepted_by_postfix" });
  const secret = "secret";
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(verifyWebhookSignature(body, secret, `sha256=${signature}`), true);
});

test("client errors inherit from Error", () => {
  assert.ok(new APIError("x") instanceof ZaSendError);
  assert.ok(new RateLimitError("x") instanceof APIError);
  assert.ok(new ValidationError("x") instanceof APIError);
  assert.ok(new ZaSendError("x") instanceof Error);
});

test("attachmentFromFile and idempotencyKey", async () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const { attachmentFromFile } = require("../src");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zasend-")), "invoice.pdf");
  fs.writeFileSync(file, Buffer.from("%PDF-1.4 hello"));
  const attachment = attachmentFromFile(file);
  assert.deepEqual(attachment, { filename: "invoice.pdf", content: "JVBERi0xLjQgaGVsbG8=" });
  assert.equal(attachmentFromFile(file, "renamed.pdf").filename, "renamed.pdf");

  let requestedInit;
  const client = new ZaSend("key", {
    baseUrl: "https://example.test/api/v1",
    fetch: async (url, init) => {
      requestedInit = init;
      return fakeResponse({ success: true, message_id: "msg_1", status: "queued" });
    },
  });
  await client.sendEmail(
    { from: "noreply@example.com", to: "user@example.com", subject: "Invoice", text: "See attached", attachments: [attachment] },
    { idempotencyKey: "order-1" },
  );
  assert.equal(requestedInit.headers["Idempotency-Key"], "order-1");
  assert.equal(JSON.parse(requestedInit.body).attachments[0].filename, "invoice.pdf");
});

test("attachment size and type errors are validation errors", async () => {
  for (const status of [413, 415]) {
    const client = new ZaSend("key", { fetch: async () => fakeResponse({ message: "nope" }, { ok: false, status }) });
    await assert.rejects(client.sendEmail({ from: "a@example.com", to: "b@example.com", subject: "s", text: "t" }), ValidationError);
  }
});

test("inbound downloads return Buffers and use the right paths", async () => {
  const urls = [];
  const client = new ZaSend("key", {
    baseUrl: "https://example.test/api/v1",
    fetch: async (url, init) => {
      urls.push([url, init.headers.Accept]);
      return { ok: true, status: 200, statusText: "OK", async arrayBuffer() { return new TextEncoder().encode("%PDF-1.4 hello").buffer; } };
    },
  });
  const bytes = await client.downloadInboundAttachment("msg-1", 0);
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.equal(bytes.toString(), "%PDF-1.4 hello");
  assert.equal((await client.downloadInboundRaw("msg-1")).toString(), "%PDF-1.4 hello");
  assert.deepEqual(urls, [
    ["https://example.test/api/v1/inbound/msg-1/attachments/0", "*/*"],
    ["https://example.test/api/v1/inbound/msg-1/raw", "*/*"],
  ]);
});

test("getInboundMessage and download errors", async () => {
  const ok = new ZaSend("key", { fetch: async () => fakeResponse({ id: "msg-1", attachments: [{ id: 0 }] }) });
  assert.equal((await ok.getInboundMessage("msg-1")).attachments[0].id, 0);
  const missing = new ZaSend("key", { fetch: async () => fakeResponse({ message: "Files for this message were not kept." }, { ok: false, status: 404 }) });
  await assert.rejects(missing.downloadInboundRaw("msg-1"), APIError);
});

test("sendBatch posts the emails list", async () => {
  let requestedUrl;
  let requestedInit;
  const client = new ZaSend("key", {
    baseUrl: "https://example.test/api/v1",
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return fakeResponse({ success: false, queued: 1, failed: 1, results: [] }, { status: 207 });
    },
  });
  const result = await client.sendBatch([{ from: "a@example.com", to: "b@example.com" }], { idempotencyKey: "k1" });
  assert.equal(requestedUrl, "https://example.test/api/v1/emails/batch");
  assert.equal(JSON.parse(requestedInit.body).emails.length, 1);
  assert.equal(requestedInit.headers["Idempotency-Key"], "k1");
  assert.equal(result.failed, 1);
});

test("verifyWebhookSignatureV2 checks signature and age", () => {
  const crypto = require("node:crypto");
  const body = '{"event":"failed"}';
  const sig = crypto.createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex");
  const header = `t=1700000000,v1=${sig}`;
  assert.equal(verifyWebhookSignatureV2(body, "s3cret", header, { now: 1700000100 }), true);
  assert.equal(verifyWebhookSignatureV2(body, "s3cret", header, { now: 1700001000 }), false);
  assert.equal(verifyWebhookSignatureV2(`${body} `, "s3cret", header, { now: 1700000100 }), false);
  assert.equal(verifyWebhookSignatureV2(body, "s3cret", "garbage", { now: 1700000100 }), false);
});

test("SMTP password, API key and inbox list methods use the right requests", async () => {
  const calls = [];
  const client = new ZaSend("key", {
    baseUrl: "https://example.test/api/v1",
    fetch: async (url, init) => {
      calls.push([init.method, url.replace("https://example.test/api/v1", ""), init.body ? JSON.parse(init.body) : null]);
      return init.method === "DELETE"
        ? { ok: true, status: 204, async json() { return null; } }
        : fakeResponse({ ok: true });
    },
  });
  await client.listSmtpPasswords({ domain: "acme.com" });
  await client.createSmtpPassword("acme.com", { name: "WordPress" });
  await client.deleteSmtpPassword("pw/1");
  await client.listApiKeys();
  await client.createApiKey("Bot", { access: "agent", domain: "acme.com" });
  await client.revokeApiKey("k1");
  await client.listInboundMessages({ limit: 5, unread: true });
  await client.listInboundMessages({ unread: false });
  assert.deepEqual(calls, [
    ["GET", "/smtp-passwords?domain=acme.com", null],
    ["POST", "/smtp-passwords", { domain: "acme.com", name: "WordPress" }],
    ["DELETE", "/smtp-passwords/pw%2F1", null],
    ["GET", "/api-keys", null],
    ["POST", "/api-keys", { name: "Bot", access: "agent", domain: "acme.com" }],
    ["DELETE", "/api-keys/k1", null],
    ["GET", "/inbound?limit=5&unread=1", null],
    ["GET", "/inbound", null],
  ]);
});

test("a missing permission is on the error", async () => {
  const client = new ZaSend("key", {
    fetch: async () => fakeResponse({ error: "forbidden", message: "This API key doesn't have inbound access",
                                      missing_permission: "inbound" }, { ok: false, status: 403 }),
  });
  await assert.rejects(() => client.listInboundMessages(), (error) => {
    assert.ok(error instanceof APIError);
    assert.equal(error.status, 403);
    assert.equal(error.missingPermission, "inbound");
    return true;
  });
});
