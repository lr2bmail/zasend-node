const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://zasend.com/api/v1";

class ZaSendError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZaSendError";
  }
}

class APIError extends ZaSendError {
  constructor(message, status = null, body = null) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.body = body;
    // Set on a 403 when the API key lacks a permission, e.g. "inbound".
    this.missingPermission = body && body.missing_permission ? body.missing_permission : null;
  }
}

class RateLimitError extends APIError {
  constructor(message, status = 429, body = null) {
    super(message, status, body);
    this.name = "RateLimitError";
  }
}

class ValidationError extends APIError {
  constructor(message, status = 400, body = null) {
    super(message, status, body);
    this.name = "ValidationError";
  }
}

class ZaSend {
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new ZaSendError("API key is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout || 10000;
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== "function") {
      throw new ZaSendError("fetch is required. Use Node 18+ or pass options.fetch.");
    }
  }

  // `message.attachments` is a list built with attachmentFromFile (or { filename, content: <base64> }).
  // With options.idempotencyKey a retry of the same request within 24 hours returns the first
  // result instead of sending again.
  async sendEmail(message, options = {}) {
    const headers = options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined;
    return this._request("POST", "/emails/send", message, headers);
  }

  // Up to 100 different emails in one call; each item has the fields of sendEmail.
  // A partial failure is not an error: check `failed` and each item's `status` in `results`.
  async sendBatch(emails, options = {}) {
    const headers = options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined;
    return this._request("POST", "/emails/batch", { emails }, headers);
  }

  async sendTemplateEmail({ from, to, template, variables = {}, cc, bcc, listUnsubscribe, listUnsubscribePost }) {
    return this.sendEmail({
      from,
      to,
      template,
      variables,
      cc,
      bcc,
      list_unsubscribe: listUnsubscribe,
      list_unsubscribe_post: listUnsubscribePost,
    });
  }

  // Received messages, newest first, without bodies. options: { limit, domain, to, unread }.
  async listInboundMessages(options = {}) {
    const params = { ...options };
    if (params.unread !== undefined) {
      params.unread = params.unread ? "1" : undefined;
    }
    return this._request("GET", this._pathWithQuery("/inbound", params));
  }

  // A received message with its attachment list (no file content).
  async getInboundMessage(messageId) {
    return this._request("GET", `/inbound/${encodeURIComponent(messageId)}`);
  }

  // The bytes (Buffer) of one attachment of a received message; `index` is the attachment id.
  async downloadInboundAttachment(messageId, index) {
    return this._request("GET", `/inbound/${encodeURIComponent(messageId)}/attachments/${Number(index)}`, undefined, undefined, true);
  }

  // The original received message (.eml) as a Buffer.
  async downloadInboundRaw(messageId) {
    return this._request("GET", `/inbound/${encodeURIComponent(messageId)}/raw`, undefined, undefined, true);
  }

  async getEmail(messageId) {
    return this._request("GET", `/emails/${encodeURIComponent(messageId)}`);
  }

  async getRateLimits() {
    return this._request("GET", "/rate-limits");
  }

  async listDomains() {
    return this._request("GET", "/domains");
  }

  async addDomain(domain) {
    return this._request("POST", "/domains", { domain });
  }

  async verifyDomain(domainId) {
    return this._request("POST", `/domains/${encodeURIComponent(domainId)}/verify`);
  }

  async deleteDomain(domainId) {
    return this._request("DELETE", `/domains/${encodeURIComponent(domainId)}`);
  }

  async listSuppressions(options = {}) {
    return this._request("GET", this._pathWithQuery("/suppressions", options));
  }

  async addSuppression(email, options = {}) {
    return this._request("POST", "/suppressions", { email, ...options });
  }

  async deleteSuppression(suppressionId) {
    return this._request("DELETE", `/suppressions/${encodeURIComponent(suppressionId)}`);
  }

  async listWebhooks() {
    return this._request("GET", "/webhooks");
  }

  async createWebhook(url, events) {
    return this._request("POST", "/webhooks", { url, events });
  }

  async deleteWebhook(webhookId) {
    return this._request("DELETE", `/webhooks/${encodeURIComponent(webhookId)}`);
  }

  async listTemplates() {
    return this._request("GET", "/templates");
  }

  async createTemplate(template) {
    return this._request("POST", "/templates", template);
  }

  async getTemplate(templateId) {
    return this._request("GET", `/templates/${encodeURIComponent(templateId)}`);
  }

  async updateTemplate(templateId, template) {
    return this._request("PUT", `/templates/${encodeURIComponent(templateId)}`, template);
  }

  async deleteTemplate(templateId) {
    return this._request("DELETE", `/templates/${encodeURIComponent(templateId)}`);
  }

  // SMTP passwords for SMTP apps (WordPress, Laravel...). They only work over SMTP.
  async listSmtpPasswords(options = {}) {
    return this._request("GET", this._pathWithQuery("/smtp-passwords", options));
  }

  // The new password is in `password` and is returned only once.
  async createSmtpPassword(domain, options = {}) {
    return this._request("POST", "/smtp-passwords", { domain, ...options });
  }

  async deleteSmtpPassword(passwordId) {
    return this._request("DELETE", `/smtp-passwords/${encodeURIComponent(passwordId)}`);
  }

  // Managing API keys needs a Full access key.
  async listApiKeys() {
    return this._request("GET", "/api-keys");
  }

  // options.access: "sending", "agent", "full" (default) or a list of permissions;
  // options.domain limits the key to one verified domain. The new key is in `key`, returned once.
  async createApiKey(name, options = {}) {
    return this._request("POST", "/api-keys", { name, ...options });
  }

  async revokeApiKey(keyId) {
    return this._request("DELETE", `/api-keys/${encodeURIComponent(keyId)}`);
  }

  _pathWithQuery(path, params) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        search.set(key, String(value));
      }
    });
    const query = search.toString();
    return query ? `${path}?${query}` : path;
  }

  async _request(method, path, body = undefined, extraHeaders = undefined, binary = false) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const headers = {
      ...(extraHeaders || {}),
      Authorization: `Bearer ${this.apiKey}`,
      Accept: binary ? "*/*" : "application/json",
    };
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new APIError("API request timed out");
      }
      throw new APIError(error && error.message ? error.message : "API request failed");
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 204) {
      return null;
    }
    if (binary && response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      if (response.ok) {
        throw new APIError("API returned invalid JSON", response.status);
      }
    }

    if (!response.ok) {
      const message = data && data.message ? data.message : response.statusText || "API error";
      if (response.status === 429) {
        throw new RateLimitError(message, response.status, data);
      }
      if ([400, 413, 415, 422].includes(response.status)) {
        throw new ValidationError(message, response.status, data);
      }
      throw new APIError(`API error ${response.status}: ${message}`, response.status, data);
    }

    return data;
  }
}

function attachmentFromFile(filePath, filename = undefined) {
  return {
    filename: filename || path.basename(filePath),
    content: fs.readFileSync(filePath).toString("base64"),
  };
}

function verifyWebhookSignature(payloadBody, secret, signatureHeader) {
  const received = String(signatureHeader || "").replace(/^sha256=/, "");
  const expected = crypto.createHmac("sha256", secret).update(payloadBody).digest("hex");
  if (received.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

// Check X-zaSend-Signature-V2 ("t=<unix>,v1=<hmac of '<t>.<body>'>") and reject old deliveries.
function verifyWebhookSignatureV2(payloadBody, secret, signatureHeader, options = {}) {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const parts = {};
  String(signatureHeader || "").split(",").forEach((item) => {
    const index = item.indexOf("=");
    if (index > 0) {
      parts[item.slice(0, index).trim()] = item.slice(index + 1).trim();
    }
  });
  if (!/^\d+$/.test(parts.t || "") || !parts.v1) {
    return false;
  }
  if (Math.abs(now - Number(parts.t)) > tolerance) {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.`).update(payloadBody).digest("hex");
  if (parts.v1.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

module.exports = {
  APIError,
  DEFAULT_BASE_URL,
  RateLimitError,
  ValidationError,
  ZaSend,
  ZaSendError,
  attachmentFromFile,
  verifyWebhookSignature,
  verifyWebhookSignatureV2,
};
