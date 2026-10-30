// backend/services/aiProviderService.js
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../config');
const { getSystemPrompt, formatEvidencePrompt, PROMPT_VERSION, SCHEMA_VERSION } = require('../ai/prompts/systemPrompt.v1');
const { responseJsonSchema, validateAiResponse } = require('./aiResponseValidator');
const { logger: defaultLogger } = require('../logger');

// Local in-memory and disk cache for benchmark evaluations
const MEMORY_CACHE = new Map();
const CACHE_DIR = path.join(__dirname, '..', 'ai', 'evaluation', '.cache');

class AiProviderError extends Error {
  constructor(message, code = 'AI_PROVIDER_ERROR', statusCode = 500, retryable = false) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = statusCode;
    this.retryable = retryable;
    this.isRetryable = retryable;
  }
}

/**
 * Computes a deterministic cache key scoped to provider, model, prompt, schema, and evidence.
 *
 * @param {string} provider
 * @param {string} model
 * @param {string} evidenceFingerprint
 * @param {number} workspaceId
 * @returns {string}
 */
function computeCacheKey(provider, model, evidenceFingerprint, workspaceId) {
  return crypto
    .createHash('sha256')
    .update(`${provider}:${model}:${PROMPT_VERSION}:${SCHEMA_VERSION}:${workspaceId}:${evidenceFingerprint}`)
    .digest('hex');
}

/**
 * Base AI Provider interface.
 */
class BaseAiProvider {
  constructor(config = {}, logger = defaultLogger) {
    this.config = config;
    this.logger = logger;
  }

  async generateAnalysis(_evidenceSnapshot, _options = {}) {
    throw new Error('generateAnalysis() must be implemented by subclass');
  }
}

/**
 * Disabled Provider — default when AI_PROVIDER=disabled.
 */
class DisabledAiProvider extends BaseAiProvider {
  async generateAnalysis(_evidenceSnapshot, _options = {}) {
    throw new AiProviderError(
      'AI incident investigation is currently disabled in configuration (AI_PROVIDER=disabled)',
      'AI_DISABLED',
      503,
      false
    );
  }
}

/**
 * Gemini API Provider.
 * Calls Google Gemini REST API using structured JSON mode (responseMimeType: "application/json").
 */
class GeminiAiProvider extends BaseAiProvider {
  constructor(config = {}, logger = defaultLogger) {
    super(config, logger);
    this.apiKey = (config.ai && config.ai.gemini && config.ai.gemini.apiKey) || process.env.GEMINI_API_KEY || '';
    this.model = (config.ai && config.ai.gemini && config.ai.gemini.model) || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    this.timeoutMs = (config.ai && config.ai.gemini && config.ai.gemini.timeoutMs) || (config.ai && config.ai.timeoutMs) || 30000;
  }

  async generateAnalysis(evidenceSnapshot, options = {}) {
    if (!this.apiKey) {
      throw new AiProviderError('GEMINI_API_KEY is not configured', 'GEMINI_AUTH_MISSING', 401, false);
    }

    const modelName = options.model || this.model;
    const systemInstruction = getSystemPrompt();
    const promptText = formatEvidencePrompt(evidenceSnapshot);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const requestBody = {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: promptText }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 2500,
      },
    };

    const startTime = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (networkErr) {
      const isTimeout = networkErr.name === 'TimeoutError' || networkErr.message.includes('timeout');
      throw new AiProviderError(
        `Gemini API request failed: ${isTimeout ? 'Request timed out after ' + this.timeoutMs + 'ms' : networkErr.message}`,
        isTimeout ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR',
        504,
        isTimeout
      );
    }

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const status = response.status;
      let errBody = '';
      let errMsg = '';
      try {
        errBody = await response.text();
        const parsed = JSON.parse(errBody);
        if (parsed.error && parsed.error.message) {
          errMsg = parsed.error.message;
        }
      } catch (_e) {
        // Ignore text error
      }
      if (!errMsg && errBody) {
        errMsg = errBody.substring(0, 200);
      }
      // Redact potential keys or sensitive tokens from error message
      errMsg = errMsg.replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_KEY]');

      const isRateLimit = status === 429;
      const isQuota = status === 403 || errBody.includes('RESOURCE_EXHAUSTED');
      const isRetryable = status === 429 || status >= 500;

      this.logger.warn({ status, durationMs, error: errMsg }, 'Gemini API call failed');

      const failureReason = errMsg
        ? `${isRateLimit ? 'Rate limit exceeded: ' : isQuota ? 'Quota exhausted: ' : ''}${errMsg}`
        : (isRateLimit ? 'Rate limit exceeded' : isQuota ? 'Quota exhausted' : 'Upstream error');

      throw new AiProviderError(
        `Gemini API returned HTTP ${status}: ${failureReason}`,
        isRateLimit ? 'AI_RATE_LIMIT' : isQuota ? 'AI_QUOTA_EXHAUSTED' : 'AI_UPSTREAM_ERROR',
        status,
        isRetryable
      );
    }

    const data = await response.json();
    const candidate = data.candidates && data.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
      throw new AiProviderError('Gemini API returned empty candidates or blocked response', 'AI_EMPTY_RESPONSE', 502, false);
    }

    const rawText = candidate.content.parts[0].text;
    const usageMetadata = data.usageMetadata || {};

    return {
      rawText,
      provider: 'gemini',
      model: modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      durationMs,
      tokens: {
        prompt: usageMetadata.promptTokenCount || null,
        completion: usageMetadata.candidatesTokenCount || null,
        total: usageMetadata.totalTokenCount || null,
      },
    };
  }
}

/**
 * Ollama Local Model Server Provider.
 * Calls local Ollama API (e.g. http://localhost:11434/api/generate) with structured JSON schema format.
 */
class OllamaAiProvider extends BaseAiProvider {
  constructor(config = {}, logger = defaultLogger) {
    super(config, logger);
    this.baseUrl = (config.ai && config.ai.ollama && config.ai.ollama.baseUrl) || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = (config.ai && config.ai.ollama && config.ai.ollama.model) || process.env.OLLAMA_MODEL || 'qwen3.5:4b';
    this.timeoutMs = (config.ai && config.ai.ollama && config.ai.ollama.timeoutMs) || (config.ai && config.ai.timeoutMs) || 120000;
  }

  async generateAnalysis(evidenceSnapshot, options = {}) {
    const modelName = options.model || this.model;
    const systemPrompt = getSystemPrompt();
    const promptText = formatEvidencePrompt(evidenceSnapshot);

    const url = `${this.baseUrl}/api/generate`;

    // Attempt structured JSON schema constrained decoding where supported by Ollama
    const requestBody = {
      model: modelName,
      system: systemPrompt,
      prompt: promptText,
      format: options.format || responseJsonSchema || 'json',
      stream: false,
      options: {
        temperature: 0.1,
      },
    };

    const startTime = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // If Ollama rejects JSON schema format with 400, fallback to standard format: 'json'
      if (!response.ok && response.status === 400 && requestBody.format !== 'json') {
        this.logger.warn({ status: response.status }, 'Ollama rejected structured schema format; falling back to format: "json"');
        requestBody.format = 'json';
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      }
    } catch (networkErr) {
      const isTimeout = networkErr.name === 'TimeoutError' || networkErr.message.includes('timeout');
      throw new AiProviderError(
        `Ollama request failed: ${isTimeout ? 'Request timed out after ' + this.timeoutMs + 'ms' : networkErr.message}`,
        isTimeout ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR',
        504,
        isTimeout
      );
    }

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const status = response.status;
      let errBody = '';
      try {
        errBody = await response.text();
      } catch (_e) { }
      throw new AiProviderError(
        `Ollama returned HTTP ${status}: ${errBody ? errBody.substring(0, 200) : 'Verify Ollama is running and model "' + modelName + '" is pulled'}`,
        'OLLAMA_ERROR',
        status,
        status >= 500
      );
    }

    const data = await response.json();
    const rawText = data.response;
    if (!rawText || typeof rawText !== 'string') {
      throw new AiProviderError('Ollama returned empty response string', 'AI_EMPTY_RESPONSE', 502, false);
    }

    return {
      rawText,
      provider: 'ollama',
      model: modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      durationMs,
      tokens: {
        prompt: data.prompt_eval_count || null,
        completion: data.eval_count || null,
        total: (data.prompt_eval_count || 0) + (data.eval_count || 0) || null,
      },
    };
  }
}

/**
 * OpenRouter Provider (OpenAI-compatible chat completions API).
 * Calls https://openrouter.ai/api/v1/chat/completions with model-specific structured output options.
 */
class OpenRouterAiProvider extends BaseAiProvider {
  constructor(config = {}, logger = defaultLogger) {
    super(config, logger);
    this.apiKey = (config.ai && config.ai.openrouter && config.ai.openrouter.apiKey) || process.env.OPENROUTER_API_KEY || '';
    this.baseUrl = (config.ai && config.ai.openrouter && config.ai.openrouter.baseUrl) || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    this.model = (config.ai && config.ai.openrouter && config.ai.openrouter.model) || process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free';
    this.timeoutMs = (config.ai && config.ai.openrouter && config.ai.openrouter.timeoutMs) || (config.ai && config.ai.timeoutMs) || 60000;
    this.maxTokens = (config.ai && config.ai.openrouter && config.ai.openrouter.maxTokens)
      || (process.env.OPENROUTER_MAX_TOKENS ? Number(process.env.OPENROUTER_MAX_TOKENS) : null);
  }

  determineResponseFormat(modelName, explicitFormat = null) {
    if (explicitFormat) return explicitFormat;
    // Gemma models on OpenRouter generally support json_object mode rather than strict json_schema
    if (typeof modelName === 'string' && modelName.toLowerCase().includes('gemma')) {
      return { type: 'json_object' };
    }
    // GPT-OSS 20B and Nemotron 3.5 Super VL support json_schema structured output
    return {
      type: 'json_schema',
      json_schema: {
        name: 'incident_investigation',
        strict: true,
        schema: responseJsonSchema,
      },
    };
  }

  determineMaxTokens(modelName, explicitMaxTokens = null) {
    if (explicitMaxTokens && Number.isInteger(explicitMaxTokens) && explicitMaxTokens > 0) {
      return explicitMaxTokens;
    }
    if (this.maxTokens && Number.isInteger(this.maxTokens) && this.maxTokens > 0) {
      return this.maxTokens;
    }
    // Specific maximum completion allowance of 4,000 tokens for Nemotron
    if (typeof modelName === 'string' && modelName.toLowerCase().includes('nemotron')) {
      return 4000;
    }
    return 2500;
  }

  async generateAnalysis(evidenceSnapshot, options = {}) {
    if (!this.apiKey) {
      throw new AiProviderError('OPENROUTER_API_KEY is not configured', 'OPENROUTER_AUTH_MISSING', 401, false);
    }

    const modelName = options.model || this.model;
    const systemPrompt = getSystemPrompt();
    const promptText = formatEvidencePrompt(evidenceSnapshot);

    const endpointUrl = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const responseFormat = this.determineResponseFormat(modelName, options.responseFormat || options.format);
    const maxTokens = this.determineMaxTokens(modelName, options.max_tokens || options.maxTokens);

    const requestBody = {
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptText },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    };
    if (responseFormat) {
      requestBody.response_format = responseFormat;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://apidash.local',
      'X-Title': 'APIDash Incident Investigation',
    };

    let requestAttempts = 1;
    const startTime = Date.now();
    let response;
    try {
      response = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Fallback: If model/endpoint rejects strict json_schema with HTTP 400, fallback to standard json_object mode
      if (!response.ok && response.status === 400 && requestBody.response_format && requestBody.response_format.type === 'json_schema') {
        this.logger.warn({ model: modelName }, 'OpenRouter model rejected json_schema; retrying with json_object format');
        requestBody.response_format = { type: 'json_object' };
        requestAttempts++;
        response = await fetch(endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      }
    } catch (networkErr) {
      const isTimeout = networkErr.name === 'TimeoutError' || networkErr.message.includes('timeout');
      throw new AiProviderError(
        `OpenRouter request failed: ${isTimeout ? 'Request timed out after ' + this.timeoutMs + 'ms' : networkErr.message}`,
        isTimeout ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR',
        504,
        isTimeout
      );
    }

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const status = response.status;
      let errBody = '';
      let errMsg = '';
      try {
        errBody = await response.text();
        const parsed = JSON.parse(errBody);
        if (parsed.error && parsed.error.message) {
          errMsg = parsed.error.message;
        }
      } catch (_e) { }
      if (!errMsg && errBody) {
        errMsg = errBody.substring(0, 200);
      }
      // Redact any sensitive API keys or tokens in error message
      errMsg = errMsg.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');

      const isRateLimit = status === 429 || errMsg.toLowerCase().includes('rate limit');
      const isQuota = status === 402 || status === 403 || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('credit');
      const isRetryable = status === 429 || status >= 500;

      this.logger.warn({ status, durationMs, error: errMsg }, 'OpenRouter API call failed');

      const failureReason = errMsg
        ? `${isRateLimit ? 'Rate limit exceeded: ' : isQuota ? 'Quota/Credit exhausted: ' : ''}${errMsg}`
        : (isRateLimit ? 'Rate limit exceeded' : isQuota ? 'Quota exhausted' : 'Upstream error');

      throw new AiProviderError(
        `OpenRouter returned HTTP ${status}: ${failureReason}`,
        isRateLimit ? 'AI_RATE_LIMIT' : isQuota ? 'AI_QUOTA_EXHAUSTED' : 'AI_UPSTREAM_ERROR',
        status,
        isRetryable
      );
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    const message = choice && choice.message;
    const rawContent = message && message.content;
    if (!rawContent || typeof rawContent !== 'string') {
      throw new AiProviderError('OpenRouter returned empty choices or missing content', 'AI_EMPTY_RESPONSE', 502, false);
    }

    let rawText = rawContent.trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    return {
      rawText,
      provider: 'openrouter',
      model: modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      durationMs,
      finishReason: choice ? choice.finish_reason : null,
      requestAttempts,
      tokens: {
        prompt: data.usage && data.usage.prompt_tokens != null ? data.usage.prompt_tokens : null,
        completion: data.usage && data.usage.completion_tokens != null ? data.usage.completion_tokens : null,
        total: data.usage && data.usage.total_tokens != null ? data.usage.total_tokens : null,
      },
    };
  }
}

/**
 * Groq Provider (OpenAI-compatible chat completions API).
 * Calls https://api.groq.com/openai/v1/chat/completions with strict JSON schema structured output.
 */
class GroqAiProvider extends BaseAiProvider {
  constructor(config = {}, logger = defaultLogger) {
    super(config, logger);
    this.apiKey = (config.ai && config.ai.groq && config.ai.groq.apiKey) || process.env.GROQ_API_KEY || '';
    this.baseUrl = (config.ai && config.ai.groq && config.ai.groq.baseUrl) || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    this.model = (config.ai && config.ai.groq && config.ai.groq.model) || process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
    this.timeoutMs = (config.ai && config.ai.groq && config.ai.groq.timeoutMs) || (config.ai && config.ai.timeoutMs) || 30000;
    this.maxTokens = (config.ai && config.ai.groq && config.ai.groq.maxTokens)
      || (process.env.GROQ_MAX_TOKENS ? Number(process.env.GROQ_MAX_TOKENS) : null);
  }

  determineResponseFormat(explicitFormat = null) {
    if (explicitFormat) return explicitFormat;
    // APIDash responseJsonSchema contains optional fields (e.g. recommended_checks.evidence_ids,
    // hypotheses.contradicting_evidence_ids) that violate Groq's strict token-level schema constraint
    // (which requires every property to be listed in `required`).
    // Using json_object mode directly avoids a predictable HTTP 400 rejection on every call.
    return { type: 'json_object' };
  }

  determineMaxTokens(explicitMaxTokens = null) {
    if (explicitMaxTokens && Number.isInteger(explicitMaxTokens) && explicitMaxTokens > 0) {
      return explicitMaxTokens;
    }
    if (this.maxTokens && Number.isInteger(this.maxTokens) && this.maxTokens > 0) {
      return this.maxTokens;
    }
    return 4000;
  }

  async generateAnalysis(evidenceSnapshot, options = {}) {
    if (!this.apiKey) {
      throw new AiProviderError('GROQ_API_KEY is not configured', 'GROQ_AUTH_MISSING', 401, false);
    }

    const modelName = options.model || this.model;
    const systemPrompt = getSystemPrompt();
    const promptText = formatEvidencePrompt(evidenceSnapshot);

    const endpointUrl = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const responseFormat = this.determineResponseFormat(options.responseFormat || options.format);
    const maxTokens = this.determineMaxTokens(options.max_tokens || options.maxTokens);

    const requestBody = {
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptText },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    };
    if (responseFormat) {
      requestBody.response_format = responseFormat;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    let requestAttempts = 1;
    const startTime = Date.now();
    let response;
    try {
      response = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Fallback: If model/endpoint rejects strict json_schema with HTTP 400, fallback to standard json_object mode
      if (!response.ok && response.status === 400 && requestBody.response_format && requestBody.response_format.type === 'json_schema') {
        this.logger.warn({ model: modelName }, 'Groq model rejected json_schema; retrying with json_object format');
        requestBody.response_format = { type: 'json_object' };
        requestAttempts++;
        response = await fetch(endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      }
    } catch (networkErr) {
      const isTimeout = networkErr.name === 'TimeoutError' || networkErr.message.includes('timeout');
      throw new AiProviderError(
        `Groq request failed: ${isTimeout ? 'Request timed out after ' + this.timeoutMs + 'ms' : networkErr.message}`,
        isTimeout ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR',
        504,
        isTimeout
      );
    }

    const durationMs = Date.now() - startTime;

    const remainingTokensHeader = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('x-ratelimit-remaining-tokens')
      : null;
    const resetTokensHeader = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('x-ratelimit-reset-tokens')
      : null;
    const retryAfterHeader = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('retry-after')
      : null;

    const rateLimit = {
      remainingTokens: remainingTokensHeader != null && !isNaN(parseInt(remainingTokensHeader, 10))
        ? parseInt(remainingTokensHeader, 10)
        : null,
      resetTokens: resetTokensHeader || null,
      retryAfter: retryAfterHeader != null && !isNaN(parseFloat(retryAfterHeader))
        ? parseFloat(retryAfterHeader)
        : null,
    };

    if (!response.ok) {
      const status = response.status;
      let errBody = '';
      let errMsg = '';
      try {
        errBody = await response.text();
        const parsed = JSON.parse(errBody);
        if (parsed.error && parsed.error.message) {
          errMsg = parsed.error.message;
        }
      } catch (_e) { }
      if (!errMsg && errBody) {
        errMsg = errBody.substring(0, 200);
      }
      // Redact any sensitive API keys or tokens in error message
      errMsg = errMsg
        .replace(/gsk_[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
        .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');

      let code = 'AI_UPSTREAM_ERROR';
      let isRetryable = status >= 500;

      if (status === 400) {
        code = 'AI_BAD_REQUEST';
        isRetryable = false;
      } else if (status === 401) {
        code = 'AI_AUTH_FAILED';
        isRetryable = false;
      } else if (status === 403) {
        code = errMsg.toLowerCase().includes('quota') ? 'AI_QUOTA_EXHAUSTED' : 'AI_FORBIDDEN';
        isRetryable = false;
      } else if (status === 404) {
        code = 'AI_MODEL_NOT_FOUND';
        isRetryable = false;
      } else if (status === 413) {
        code = 'AI_PAYLOAD_TOO_LARGE';
        isRetryable = false;
      } else if (status === 422) {
        code = 'AI_UNPROCESSABLE_ENTITY';
        isRetryable = false;
      } else if (status === 429) {
        code = 'AI_RATE_LIMIT';
        isRetryable = true;
      }

      this.logger.warn({ status, durationMs, error: errMsg }, 'Groq API call failed');

      const err = new AiProviderError(
        `Groq returned HTTP ${status}: ${errMsg || 'Upstream error'}`,
        code,
        status,
        isRetryable
      );
      err.rateLimit = rateLimit;
      err.retryAfter = rateLimit.retryAfter;
      err.resetTokens = rateLimit.resetTokens;
      err.remainingTokens = rateLimit.remainingTokens;
      throw err;
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    const message = choice && choice.message;
    const rawContent = message && message.content;
    if (!rawContent || typeof rawContent !== 'string') {
      throw new AiProviderError('Groq returned empty choices or missing content', 'AI_EMPTY_RESPONSE', 502, false);
    }

    let rawText = rawContent.trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    return {
      rawText,
      provider: 'groq',
      model: modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      durationMs,
      finishReason: choice ? choice.finish_reason : null,
      requestAttempts,
      rateLimit,
      tokens: {
        prompt: data.usage && data.usage.prompt_tokens != null ? data.usage.prompt_tokens : null,
        completion: data.usage && data.usage.completion_tokens != null ? data.usage.completion_tokens : null,
        total: data.usage && data.usage.total_tokens != null ? data.usage.total_tokens : null,
      },
    };
  }
}

/**
 * Mock Provider for deterministic offline testing and benchmark dry-runs.
 */
class MockAiProvider extends BaseAiProvider {
  constructor(responses = new Map(), config = {}, logger = defaultLogger) {
    super(config, logger);
    this.responses = responses;
  }

  setMockResponse(key, responseObj) {
    this.responses.set(key, responseObj);
  }

  async generateAnalysis(evidenceSnapshot, options = {}) {
    const incidentId = evidenceSnapshot.incident_id || 1;
    const observations = evidenceSnapshot.observations || [];
    const firstObsId = observations[0] ? observations[0].id : 'E-001';

    // If a mock response is explicitly provided for this incident ID
    if (this.responses.has(incidentId)) {
      const resp = this.responses.get(incidentId);
      return {
        rawText: typeof resp === 'string' ? resp : JSON.stringify(resp),
        provider: 'mock',
        model: options.model || 'mock-model',
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        durationMs: 15,
        tokens: { prompt: 100, completion: 80, total: 180 },
      };
    }

    // Default compliant mock output grounded in first observed ID
    const defaultResponse = {
      summary: `Automated investigation for incident #${incidentId}.`,
      observed_facts: [
        {
          fact: `Observed incident state record ${firstObsId}.`,
          evidence_ids: [firstObsId],
        },
      ],
      hypotheses: [
        {
          hypothesis: 'Upstream operational degradation detected by monitoring probe.',
          rationale: 'Observed non-healthy execution sequence in monitor telemetry.',
          supporting_evidence_ids: [firstObsId],
          contradicting_evidence_ids: [],
          strength: 'moderate',
        },
      ],
      recommended_checks: [
        {
          check: 'Verify upstream server health and deployment events.',
          rationale: 'Correlate timing of failure with service activity.',
          evidence_ids: [firstObsId],
        },
      ],
      unknowns: [
        'Internal application stack traces and database performance metrics are not accessible to APIDash.',
      ],
      overall_assessment: {
        confidence: 'medium',
        rationale: 'Evidence is sufficient to establish external failure but internal root cause requires server logs.',
      },
    };

    return {
      rawText: JSON.stringify(defaultResponse),
      provider: 'mock',
      model: options.model || 'mock-model',
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      durationMs: 10,
      tokens: { prompt: 85, completion: 65, total: 150 },
    };
  }
}

/**
 * Parses rate-limit reset string (e.g. '6s', '6.12s', '250ms', '1m10s') into milliseconds.
 *
 * @param {string|number} resetStr
 * @returns {number}
 */
function parseResetTimeToMs(resetStr) {
  if (!resetStr) return 0;
  let totalMs = 0;
  const matches = String(resetStr).match(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g);
  if (!matches) {
    const num = parseFloat(resetStr);
    return isNaN(num) ? 0 : Math.round(num * 1000);
  }
  for (const part of matches) {
    const num = parseFloat(part);
    if (part.endsWith('ms')) totalMs += num;
    else if (part.endsWith('s')) totalMs += num * 1000;
    else if (part.endsWith('m')) totalMs += num * 60000;
    else if (part.endsWith('h')) totalMs += num * 3600000;
  }
  return Math.ceil(totalMs);
}

/**
 * Process-local in-memory rate-limit tracking for the primary AI provider (Groq).
 * Captures rate-limit headers (remaining tokens, reset time, retry-after).
 * Clears naturally as timestamps expire; does not run background timers or use DB tables.
 */
class ProcessRateLimitTracker {
  constructor() {
    this.blockedUntil = 0;
    this.remainingTokens = null;
    this.resetAt = 0;
    this.lastRetryAfterSec = null;
  }

  recordSuccess(rateLimit) {
    if (!rateLimit) return;
    this.remainingTokens = rateLimit.remainingTokens != null ? rateLimit.remainingTokens : null;
    const now = Date.now();
    const resetMs = parseResetTimeToMs(rateLimit.resetTokens) || (rateLimit.retryAfter ? Math.ceil(rateLimit.retryAfter * 1000) : 0);
    this.resetAt = resetMs > 0 ? now + resetMs : 0;
    if (rateLimit.retryAfter) {
      this.lastRetryAfterSec = Math.ceil(rateLimit.retryAfter);
    }

    // If remaining tokens is critically low (< 2,500), consider blocked until token reset window
    if (this.remainingTokens !== null && this.remainingTokens < 2500 && resetMs > 0) {
      this.blockedUntil = Math.max(this.blockedUntil, this.resetAt);
    }
  }

  recordRateLimit(rateLimit, defaultBlockMs = 10000) {
    const now = Date.now();
    let blockMs = defaultBlockMs;
    if (rateLimit) {
      if (rateLimit.remainingTokens != null) {
        this.remainingTokens = rateLimit.remainingTokens;
      }
      if (rateLimit.retryAfter) {
        this.lastRetryAfterSec = Math.ceil(rateLimit.retryAfter);
      }
      const parsedMs = parseResetTimeToMs(rateLimit.resetTokens) || (rateLimit.retryAfter ? Math.ceil(rateLimit.retryAfter * 1000) : 0);
      if (parsedMs > 0) {
        blockMs = parsedMs;
      }
    }
    this.blockedUntil = Math.max(this.blockedUntil, now + blockMs);
    this.resetAt = Math.max(this.resetAt, this.blockedUntil);
  }

  isBlocked(estimatedTokens = 2500) {
    const now = Date.now();
    // Lazy expiration
    if (now >= this.blockedUntil) {
      this.blockedUntil = 0;
      if (now >= this.resetAt) {
        this.remainingTokens = null;
      }
    }

    if (now < this.blockedUntil) {
      return true;
    }

    if (this.remainingTokens !== null && now < this.resetAt && this.remainingTokens < estimatedTokens) {
      return true;
    }

    return false;
  }

  getRetryAfterSec() {
    const now = Date.now();
    if (now < this.blockedUntil) {
      return Math.max(1, Math.ceil((this.blockedUntil - now) / 1000));
    }
    return this.lastRetryAfterSec || 10;
  }

  reset() {
    this.blockedUntil = 0;
    this.remainingTokens = null;
    this.resetAt = 0;
    this.lastRetryAfterSec = null;
  }
}

function getSafeCategoryMessage(category) {
  switch (category) {
    case 'AUTH_CONFIGURATION_ERROR':
      return 'Primary provider configuration or credential error.';
    case 'CLIENT_BAD_REQUEST':
      return 'Primary provider rejected request parameters.';
    case 'RATE_LIMIT':
      return 'Primary provider rate limit threshold reached.';
    case 'TIMEOUT':
      return 'Primary provider request timed out.';
    case 'CONNECTION_FAILURE':
      return 'Unable to establish network connection to primary provider.';
    case 'UPSTREAM_SERVER_ERROR':
      return 'Primary provider upstream server error.';
    case 'SCHEMA_OR_CITATION_FAILURE':
      return 'Primary provider output failed schema or evidence reference verification.';
    default:
      return 'Primary provider diagnostic failure.';
  }
}

/**
 * Single-alternative fallback composite provider.
 * Primary: Groq (openai/gpt-oss-20b)
 * Alternative: OpenRouter (nvidia/nemotron-3.5-super-vl:free)
 *
 * Routing Policy:
 * 1. Checks in-memory rate-limit state. If primary is known to be blocked, fast-paths to alternative.
 * 2. If unblocked, calls primary.
 * 3. If primary fails with retryable / 429 / 5xx / timeout / quota error, records rate limit and falls back to alternative.
 * 4. Never loops or retries primary; never routes to a third provider.
 * 5. If both fail, throws AI_DUAL_PROVIDER_EXHAUSTION with retryable: false (to prevent worker endless loops)
 *    and a safe user message without leaking keys, tokens, or traces.
 */
class FallbackAiProvider extends BaseAiProvider {
  constructor(options = {}, logger = defaultLogger) {
    const config = options.config || loadConfig();
    super(config, logger);

    this.primary = options.primary || new GroqAiProvider(config, logger);
    this.alternative = options.alternative || new OpenRouterAiProvider(config, logger);
    this.tracker = options.tracker || new ProcessRateLimitTracker();

    this.primaryModel = options.primaryModel || (config.ai && config.ai.groq && config.ai.groq.model) || 'openai/gpt-oss-20b';
    this.alternativeModel = options.alternativeModel || 'nvidia/nemotron-3.5-super-vl:free';
  }

  async generateAnalysis(evidenceSnapshot, options = {}) {
    // 0. Local preflight validation: If evidence snapshot is invalid, call neither provider
    if (!evidenceSnapshot || typeof evidenceSnapshot !== 'object' || !Array.isArray(evidenceSnapshot.observations) || evidenceSnapshot.observations.length === 0) {
      throw new AiProviderError('Invalid evidence snapshot: missing observations array', 'INVALID_EVIDENCE_SNAPSHOT', 400, false);
    }

    const estimatedTokens = 2500;
    let fallbackOccurred = false;
    let primaryError = null;

    // 1. Fast-path check: Is primary known to be blocked?
    if (this.tracker.isBlocked(estimatedTokens)) {
      fallbackOccurred = true;
      const retryAfterSec = this.tracker.getRetryAfterSec();
      primaryError = {
        code: 'AI_RATE_LIMIT',
        status: 429,
        category: 'RATE_LIMIT',
        message: `Primary provider (Groq) is currently rate-limited (blocked for ~${retryAfterSec}s). Fast-pathing to alternative.`,
        fastPath: true,
      };
      this.logger.warn({ primaryModel: this.primaryModel, retryAfterSec }, 'Fast-path fallback: primary provider is rate-limited; routing directly to alternative');
    } else {
      // 2. Attempt Primary
      try {
        const primaryResult = await this.primary.generateAnalysis(evidenceSnapshot, {
          model: this.primaryModel,
          ...options,
        });

        // Validate primary server-side output (schema & evidence references)
        const validation = validateAiResponse(primaryResult.rawText, evidenceSnapshot);
        if (validation.valid && (validation.invalidEvidenceIds || []).length === 0) {
          if (primaryResult.rateLimit) {
            this.tracker.recordSuccess(primaryResult.rateLimit);
          }
          return {
            ...primaryResult,
            fallback_occurred: false,
            primary_error: null,
          };
        }

        // Primary response is malformed JSON, schema invalid, or has invalid evidence references
        fallbackOccurred = true;
        primaryError = {
          code: 'INVALID_AI_OUTPUT',
          status: 422,
          category: 'SCHEMA_OR_CITATION_FAILURE',
          message: validation.errors.join('; ') || 'Primary model returned invalid evidence references',
        };
        this.logger.warn({ primaryError, primaryProvider: 'groq' }, 'Primary AI response failed server-side validation; falling back to alternative provider');
      } catch (err) {
        if (err.code === 'AI_RATE_LIMIT' || err.statusCode === 429 || err.code === 'AI_QUOTA_EXHAUSTED' || err.statusCode === 403) {
          this.tracker.recordRateLimit(err.rateLimit);
        }

        fallbackOccurred = true;
        let category = 'PROVIDER_ERROR';
        if (err.statusCode === 400 || err.status === 400) category = 'CLIENT_BAD_REQUEST';
        else if (err.statusCode === 401 || err.status === 401) category = 'AUTH_CONFIGURATION_ERROR';
        else if (err.statusCode === 429 || err.code === 'AI_RATE_LIMIT') category = 'RATE_LIMIT';
        else if (err.code === 'AI_TIMEOUT' || (err.message && err.message.toLowerCase().includes('timeout'))) category = 'TIMEOUT';
        else if ((err.statusCode && err.statusCode >= 500) || (err.status && err.status >= 500)) category = 'UPSTREAM_SERVER_ERROR';
        else if (err.code === 'AI_NETWORK_ERROR') category = 'CONNECTION_FAILURE';

        primaryError = {
          code: err.code || 'AI_PROVIDER_ERROR',
          status: err.statusCode || err.status || 500,
          category,
          message: getSafeCategoryMessage(category),
          retryAfter: err.retryAfter || null,
        };

        // Preserve underlying primary configuration/request error in server-side diagnostics
        this.logger.warn(
          { primaryError: err.message, code: err.code, status: err.statusCode || err.status, category, primaryProvider: 'groq', alternativeModel: this.alternativeModel },
          'Primary AI provider failed; preserving diagnostic and falling back to alternative provider'
        );
      }
    }

    // 3. Attempt Alternative (single attempt, no loops, no third provider)
    try {
      const altResult = await this.alternative.generateAnalysis(evidenceSnapshot, {
        model: this.alternativeModel,
        ...options,
      });

      // Validate alternative server-side output against schema and evidence references
      const altValidation = validateAiResponse(altResult.rawText, evidenceSnapshot);
      if (!altValidation.valid || (altValidation.invalidEvidenceIds || []).length > 0) {
        throw new AiProviderError(
          altValidation.errors.join('; ') || 'Alternative model returned invalid evidence references',
          'INVALID_AI_OUTPUT',
          422,
          false
        );
      }

      return {
        ...altResult,
        fallback_occurred: true,
        provider: 'openrouter', // actual successful provider
        model: altResult.model || this.alternativeModel, // actual successful model
        composite_provider: 'groq->openrouter',
        primary_provider: 'groq',
        primary_model: this.primaryModel,
        primary_failure_category: primaryError.category,
        primary_error: primaryError,
      };
    } catch (altErr) {
      this.logger.error(
        { primaryError, altError: altErr.message },
        'Both primary and alternative AI providers failed (dual exhaustion)'
      );

      const isRateLimited = (primaryError && primaryError.category === 'RATE_LIMIT') ||
                            altErr.code === 'AI_RATE_LIMIT' ||
                            altErr.statusCode === 429;

      const retryAfterSec = this.tracker.getRetryAfterSec();
      const hasTrustworthyRetryAfter = Number.isInteger(retryAfterSec) && retryAfterSec > 0 && retryAfterSec <= 3600;

      const retryHint = (isRateLimited && hasTrustworthyRetryAfter)
        ? ` You may try requesting AI analysis again in approximately ${retryAfterSec} seconds.`
        : ' You may request analysis again at any time.';

      const safeUserMessage = `AI incident investigation could not be completed at this time. All monitoring probes and incident history remain fully operational and accessible.${retryHint}`;

      // Crucial for worker retry coordination:
      // Mark as non-retryable so the outer worker does NOT re-claim and duplicate the dual-provider execution loop!
      const combinedError = new AiProviderError(
        safeUserMessage,
        'AI_DUAL_PROVIDER_EXHAUSTION',
        503,
        false // retryable = false
      );
      combinedError.primaryError = primaryError;
      combinedError.alternativeError = {
        category: altErr.code === 'INVALID_AI_OUTPUT' ? 'SCHEMA_OR_CITATION_FAILURE' : (altErr.code === 'AI_RATE_LIMIT' || altErr.statusCode === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR'),
        code: altErr.code || 'AI_PROVIDER_ERROR',
        status: altErr.statusCode || altErr.status || 500,
        message: 'Alternative provider diagnostic failure.',
      };
      combinedError.retryAfter = (isRateLimited && hasTrustworthyRetryAfter) ? retryAfterSec : null;
      throw combinedError;
    }
  }
}

/**
 * Factory creating the active configured provider.
 *
 * @param {Object} [overrideConfig]
 * @param {import('pino').Logger} [logger]
 * @returns {BaseAiProvider}
 */
function createAiProvider(overrideConfig = null, logger = defaultLogger) {
  const config = overrideConfig || loadConfig();
  const providerType = (config.ai && config.ai.provider) || 'disabled';

  switch (providerType) {
    case 'fallback':
      return new FallbackAiProvider({ config }, logger);
    case 'gemini':
      return new GeminiAiProvider(config, logger);
    case 'ollama':
      return new OllamaAiProvider(config, logger);
    case 'openrouter':
      return new OpenRouterAiProvider(config, logger);
    case 'groq':
      if (config.ai && config.ai.fallbackEnabled) {
        return new FallbackAiProvider({ config }, logger);
      }
      return new GroqAiProvider(config, logger);
    case 'mock':
      return new MockAiProvider(new Map(), config, logger);
    case 'disabled':
    default:
      return new DisabledAiProvider(config, logger);
  }
}

/**
 * Gets cached evaluation analysis if available.
 *
 * @param {string} cacheKey
 * @returns {Object|null}
 */
function getCachedAnalysis(cacheKey) {
  if (MEMORY_CACHE.has(cacheKey)) {
    return MEMORY_CACHE.get(cacheKey);
  }

  try {
    const filePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      MEMORY_CACHE.set(cacheKey, data);
      return data;
    }
  } catch (_e) {
    // Ignore cache read errors
  }
  return null;
}

/**
 * Stores evaluation analysis in memory and disk cache.
 *
 * @param {string} cacheKey
 * @param {Object} data
 */
function setCachedAnalysis(cacheKey, data) {
  MEMORY_CACHE.set(cacheKey, data);
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const filePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (_e) {
    // Ignore cache write errors
  }
}

module.exports = {
  createAiProvider,
  computeCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
  AiProviderError,
  BaseAiProvider,
  DisabledAiProvider,
  GeminiAiProvider,
  OllamaAiProvider,
  OpenRouterAiProvider,
  GroqAiProvider,
  FallbackAiProvider,
  ProcessRateLimitTracker,
  MockAiProvider,
};

