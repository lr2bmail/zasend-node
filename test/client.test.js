const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  APIError,
  RateLimitError,
  ValidationError,
  ZaSend,
  ZaSendError,
  verifyWebhookSignature,
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
