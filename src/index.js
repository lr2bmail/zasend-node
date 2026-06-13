const crypto = require("node:crypto");

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

  async sendEmail(message) {
    return this._request("POST", "/emails/send", message);
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

  async _request(method, path, body = undefined) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
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
      if (response.status === 400 || response.status === 422) {
        throw new ValidationError(message, response.status, data);
      }
      throw new APIError(`API error ${response.status}: ${message}`, response.status, data);
    }

    return data;
  }
}

function verifyWebhookSignature(payloadBody, secret, signatureHeader) {
  const received = String(signatureHeader || "").replace(/^sha256=/, "");
  const expected = crypto.createHmac("sha256", secret).update(payloadBody).digest("hex");
  if (received.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

module.exports = {
  APIError,
  DEFAULT_BASE_URL,
  RateLimitError,
  ValidationError,
  ZaSend,
  ZaSendError,
  verifyWebhookSignature,
};
