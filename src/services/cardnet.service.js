/**
 * ParkingPro CardNet Payment Gateway Client
 *
 * CardNet is the dominant payment processor in the Dominican Republic.
 * Docs reference: https://developers.cardnet.com.do
 *
 * Environment variables:
 *   CARDNET_API_URL        - Base URL (sandbox: https://lab.cardnet.com.do/api/v1,
 *                                      production: https://api.cardnet.com.do/api/v1)
 *   CARDNET_MERCHANT_ID    - Merchant identifier assigned by CardNet
 *   CARDNET_API_KEY        - API key / secret assigned by CardNet
 *   CARDNET_MERCHANT_NAME  - Display name used on receipts (default: 'ParkingPro')
 *   CARDNET_ENVIRONMENT    - 'sandbox' or 'production' (default: 'sandbox')
 */

'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SANDBOX_URL  = 'https://lab.cardnet.com.do/api/v1';
const DEFAULT_PROD_URL     = 'https://api.cardnet.com.do/api/v1';
const TOKEN_REFRESH_BUFFER = 10 * 60 * 1000; // refresh 10 min before expiry
const DEFAULT_TOKEN_TTL    = 60 * 60 * 1000; // assume 60-min token lifetime
const MAX_RETRIES          = 3;
const RETRY_DELAY_MS       = 500;

/**
 * CardNet response code → internal status mapping.
 * Reference: ISO 8583 / CardNet acquirer response codes.
 */
const RESPONSE_CODE_MAP = {
    '00': 'paid',          // Approved
    '08': 'paid',          // Honour with identification (approved)
    '10': 'paid',          // Partial approval
    '85': 'paid',          // No reason to decline (approved)
    '01': 'failed',        // Refer to card issuer
    '02': 'failed',        // Refer to card issuer — special condition
    '03': 'failed',        // Invalid merchant
    '04': 'failed',        // Pick up card
    '05': 'failed',        // Do not honour / generic decline
    '06': 'failed',        // Error
    '07': 'failed',        // Pick up card — special condition
    '12': 'failed',        // Invalid transaction
    '13': 'failed',        // Invalid amount
    '14': 'failed',        // Invalid card number
    '15': 'failed',        // No such issuer
    '19': 'failed',        // Re-enter transaction
    '25': 'failed',        // Unable to locate record on file
    '30': 'failed',        // Format error
    '33': 'failed',        // Expired card
    '34': 'failed',        // Suspected fraud — pick up
    '36': 'failed',        // Restricted card
    '38': 'failed',        // Exceeded PIN attempts
    '39': 'failed',        // No credit account
    '41': 'failed',        // Lost card — pick up
    '43': 'failed',        // Stolen card — pick up
    '51': 'failed',        // Insufficient funds
    '54': 'failed',        // Expired card
    '55': 'failed',        // Incorrect PIN
    '57': 'failed',        // Transaction not permitted to cardholder
    '58': 'failed',        // Transaction not permitted to terminal
    '59': 'failed',        // Suspected fraud
    '61': 'failed',        // Withdrawal amount limit exceeded
    '62': 'failed',        // Restricted card
    '63': 'failed',        // Security violation
    '65': 'failed',        // Activity count limit exceeded
    '75': 'failed',        // PIN tries exceeded
    '76': 'failed',        // Unable to locate previous message
    '77': 'failed',        // Inconsistent with original
    '78': 'failed',        // Blocked, first use
    '82': 'failed',        // Time-out at issuer
    '91': 'failed',        // Issuer unavailable
    '92': 'failed',        // Routing error
    '93': 'failed',        // Completion cannot be performed
    '94': 'failed',        // Duplicate transmission
    '96': 'failed',        // System malfunction
    '99': 'failed',        // Unrecognized response
};

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

class CardNetError extends Error {
    /**
     * @param {string} message         - Human-readable message
     * @param {string} [responseCode]  - CardNet / ISO-8583 response code
     * @param {number} [httpStatus]    - HTTP status code from the API
     * @param {object} [raw]           - Raw response body for debugging
     */
    constructor(message, responseCode = null, httpStatus = null, raw = null) {
        super(message);
        this.name = 'CardNetError';
        this.responseCode = responseCode;
        this.httpStatus = httpStatus;
        this.raw = raw;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

// ---------------------------------------------------------------------------
// Main service class
// ---------------------------------------------------------------------------

class CardNetService {
    constructor() {
        const env = process.env.CARDNET_ENVIRONMENT || 'sandbox';

        this.environment  = env;
        this.baseUrl      = process.env.CARDNET_API_URL ||
                            (env === 'production' ? DEFAULT_PROD_URL : DEFAULT_SANDBOX_URL);
        this.merchantId   = process.env.CARDNET_MERCHANT_ID || null;
        this.apiKey       = process.env.CARDNET_API_KEY || null;
        this.merchantName = process.env.CARDNET_MERCHANT_NAME || 'ParkingPro';

        // Token cache state
        this._token       = null;
        this._tokenExpiry = 0; // epoch ms

        // Remove trailing slash for safe path concatenation
        this.baseUrl = this.baseUrl.replace(/\/+$/, '');
    }

    // -----------------------------------------------------------------------
    // Public: configuration check
    // -----------------------------------------------------------------------

    /**
     * Returns true when all required credentials are present.
     * @returns {boolean}
     */
    isConfigured() {
        return Boolean(this.merchantId && this.apiKey && this.baseUrl);
    }

    // -----------------------------------------------------------------------
    // Internal: token management
    // -----------------------------------------------------------------------

    /**
     * Obtains (or returns cached) bearer token from the CardNet auth endpoint.
     * Tokens are cached until TOKEN_REFRESH_BUFFER ms before expiry.
     *
     * @returns {Promise<string>} Bearer token
     * @throws  {CardNetError}
     */
    async _getAuthToken() {
        const now = Date.now();

        // Return cached token if still valid
        if (this._token && now < this._tokenExpiry - TOKEN_REFRESH_BUFFER) {
            return this._token;
        }

        console.log('[CardNet] Fetching new auth token...');

        const body = JSON.stringify({
            merchantId: this.merchantId,
            apiKey:     this.apiKey,
        });

        const response = await this._rawRequest('POST', '/auth/token', body, {
            Authorization: null, // no token yet
        });

        if (!response.accessToken) {
            throw new CardNetError(
                'La respuesta de autenticación no contiene accessToken',
                null,
                null,
                response
            );
        }

        this._token = response.accessToken;

        // CardNet may return expiresIn (seconds) or expiresAt (ISO timestamp)
        if (response.expiresIn) {
            this._tokenExpiry = now + response.expiresIn * 1000;
        } else if (response.expiresAt) {
            this._tokenExpiry = new Date(response.expiresAt).getTime();
        } else {
            this._tokenExpiry = now + DEFAULT_TOKEN_TTL;
        }

        console.log(
            `[CardNet] Token obtained. Expires in ~${Math.round((this._tokenExpiry - now) / 60000)} min.`
        );

        return this._token;
    }

    // -----------------------------------------------------------------------
    // Internal: HTTP layer
    // -----------------------------------------------------------------------

    /**
     * Low-level HTTP request without token injection.
     * Used by _getAuthToken (which bootstraps the token).
     *
     * @param {string}  method          - HTTP verb (GET, POST, etc.)
     * @param {string}  path            - Path relative to baseUrl (e.g. '/payments')
     * @param {string}  [bodyStr]       - JSON-serialised request body
     * @param {object}  [extraHeaders]  - Additional headers (may override defaults)
     * @returns {Promise<object>} Parsed JSON response
     * @throws  {CardNetError}
     */
    _rawRequest(method, path, bodyStr = null, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const parsedBase = url.parse(this.baseUrl);
            const fullPath   = parsedBase.pathname.replace(/\/$/, '') + path;
            const isHttps    = parsedBase.protocol === 'https:';
            const transport  = isHttps ? https : http;
            const port       = parsedBase.port
                ? parseInt(parsedBase.port, 10)
                : (isHttps ? 443 : 80);

            const headers = {
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                'X-Merchant-Id': this.merchantId || '',
                ...extraHeaders,
            };

            // Remove explicitly-nulled headers (e.g. during auth request)
            Object.keys(headers).forEach(k => {
                if (headers[k] === null || headers[k] === undefined) {
                    delete headers[k];
                }
            });

            if (bodyStr) {
                headers['Content-Length'] = Buffer.byteLength(bodyStr);
            }

            const options = {
                hostname: parsedBase.hostname,
                port,
                path:     fullPath,
                method:   method.toUpperCase(),
                headers,
            };

            const req = transport.request(options, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let parsed;
                    try {
                        parsed = data ? JSON.parse(data) : {};
                    } catch {
                        // Response is not JSON — wrap it
                        parsed = { rawBody: data };
                    }

                    // 2xx → resolve; everything else → reject with CardNetError
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        const code    = parsed.responseCode || parsed.code || null;
                        const message = parsed.responseMessage ||
                                        parsed.message ||
                                        parsed.error ||
                                        `HTTP ${res.statusCode}`;
                        reject(new CardNetError(message, code, res.statusCode, parsed));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new CardNetError(
                    `Error de red al conectar con CardNet: ${err.message}`,
                    null,
                    null,
                    null
                ));
            });

            req.setTimeout(30000, () => {
                req.destroy();
                reject(new CardNetError('Tiempo de espera agotado conectando a CardNet', null, null, null));
            });

            if (bodyStr) {
                req.write(bodyStr);
            }
            req.end();
        });
    }

    /**
     * Authenticated HTTP request with automatic token injection and retry logic.
     *
     * Retries up to MAX_RETRIES times on transient network errors (ECONNRESET,
     * ECONNREFUSED, ETIMEDOUT, ENOTFOUND) or HTTP 429/503/504 responses.
     *
     * @param {string}  method   - HTTP verb
     * @param {string}  path     - Path relative to baseUrl
     * @param {object}  [body]   - Request body (will be JSON-serialised)
     * @returns {Promise<object>} Parsed JSON response
     * @throws  {CardNetError}
     */
    async _request(method, path, body = null) {
        if (!this.isConfigured()) {
            throw new CardNetError(
                'CardNet no está configurado. Verifique las variables de entorno CARDNET_MERCHANT_ID y CARDNET_API_KEY.',
                'UNCONFIGURED'
            );
        }

        let lastError;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const token   = await this._getAuthToken();
                const bodyStr = body ? JSON.stringify(body) : null;

                const result = await this._rawRequest(method, path, bodyStr, {
                    Authorization: `Bearer ${token}`,
                });

                return result;

            } catch (err) {
                lastError = err;

                const isRetryable = this._isRetryableError(err);

                if (!isRetryable || attempt === MAX_RETRIES) {
                    break;
                }

                const delay = RETRY_DELAY_MS * attempt;
                console.warn(
                    `[CardNet] Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}. ` +
                    `Retrying in ${delay}ms...`
                );
                await _sleep(delay);

                // Force token refresh on 401
                if (err.httpStatus === 401) {
                    this._token       = null;
                    this._tokenExpiry = 0;
                }
            }
        }

        throw lastError;
    }

    /**
     * Determines whether an error warrants a retry.
     * @param {Error} err
     * @returns {boolean}
     */
    _isRetryableError(err) {
        if (!(err instanceof CardNetError)) return false;

        // Network-level transient errors
        const transientMessages = [
            'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
            'tiempo de espera', 'error de red',
        ];
        if (transientMessages.some(m => err.message.toLowerCase().includes(m.toLowerCase()))) {
            return true;
        }

        // HTTP retryable status codes
        if ([429, 503, 504].includes(err.httpStatus)) {
            return true;
        }

        // Expired token → retry after refresh
        if (err.httpStatus === 401) {
            return true;
        }

        return false;
    }

    // -----------------------------------------------------------------------
    // Public: payment operations
    // -----------------------------------------------------------------------

    /**
     * Authorize (but do not capture) a payment.
     * Amount must be in DOP major units (e.g. 1500.00 for RD$1,500).
     * Internally converted to centavos (integer).
     *
     * @param {object}  opts
     * @param {number}  opts.amount          - Amount in DOP (major units)
     * @param {string}  [opts.currency]      - Currency code (default 'DOP')
     * @param {string}  opts.cardNumber      - PAN (digits only, no spaces)
     * @param {string}  opts.cardExpMonth    - Expiry month (MM, e.g. '07')
     * @param {string}  opts.cardExpYear     - Expiry year (YY or YYYY)
     * @param {string}  opts.cardCvv         - CVV / CVC
     * @param {string}  opts.cardHolderName  - Name as printed on card
     * @param {string}  [opts.description]   - Line-item description
     * @param {string}  [opts.orderId]       - Merchant order reference
     * @returns {Promise<{transactionId, authorizationCode, status, responseCode, responseMessage, raw}>}
     */
    async createPayment({
        amount,
        currency = 'DOP',
        cardNumber,
        cardExpMonth,
        cardExpYear,
        cardCvv,
        cardHolderName,
        description,
        orderId,
    }) {
        _requireFields({ amount, cardNumber, cardExpMonth, cardExpYear, cardCvv, cardHolderName });

        const amountInCentavos = _toCentavos(amount);

        const payload = {
            merchantId:   this.merchantId,
            merchantName: this.merchantName,
            amount:       amountInCentavos,
            currency:     currency.toUpperCase(),
            card: {
                number:     cardNumber.replace(/\s+/g, ''),
                expMonth:   cardExpMonth.toString().padStart(2, '0'),
                expYear:    _normaliseYear(cardExpYear),
                cvv:        cardCvv,
                holderName: cardHolderName,
            },
            description: description || 'Servicio de estacionamiento ParkingPro',
            orderId:     orderId || `PP-${Date.now()}`,
            type:        'AUTHORIZATION',
        };

        console.log(`[CardNet] Creating authorization — orderId: ${payload.orderId}, amount: ${amountInCentavos} centavos`);

        const response = await this._request('POST', '/payments', payload);

        return this._buildPaymentResult(response);
    }

    /**
     * Capture (confirm) a previously authorized payment.
     * Supports partial capture when `amount` is provided.
     *
     * @param {string}  transactionId  - Transaction ID from createPayment
     * @param {number}  [amount]       - Optional partial capture amount (DOP major units)
     * @returns {Promise<{transactionId, status, responseCode, responseMessage, raw}>}
     */
    async capturePayment(transactionId, amount = null) {
        if (!transactionId) throw new CardNetError('transactionId es requerido para capturar');

        const payload = {};
        if (amount !== null && amount !== undefined) {
            payload.amount = _toCentavos(amount);
        }

        console.log(`[CardNet] Capturing transaction: ${transactionId}`);

        const response = await this._request('POST', `/payments/${transactionId}/capture`, payload);

        return this._buildPaymentResult(response);
    }

    /**
     * Void an authorized (not-yet-captured) payment (same-day reversal).
     *
     * @param {string} transactionId
     * @returns {Promise<{transactionId, status, responseCode, responseMessage, raw}>}
     */
    async voidPayment(transactionId) {
        if (!transactionId) throw new CardNetError('transactionId es requerido para anular');

        console.log(`[CardNet] Voiding transaction: ${transactionId}`);

        const response = await this._request('POST', `/payments/${transactionId}/void`, {});

        return this._buildPaymentResult(response);
    }

    /**
     * Refund a captured payment.
     * Supports partial refunds when `amount` is provided.
     *
     * @param {string}  transactionId
     * @param {number}  [amount]  - Optional partial refund amount (DOP major units)
     * @returns {Promise<{transactionId, status, responseCode, responseMessage, raw}>}
     */
    async refundPayment(transactionId, amount = null) {
        if (!transactionId) throw new CardNetError('transactionId es requerido para reembolsar');

        const payload = {};
        if (amount !== null && amount !== undefined) {
            payload.amount = _toCentavos(amount);
        }

        console.log(`[CardNet] Refunding transaction: ${transactionId}${amount !== null ? `, amount: ${_toCentavos(amount)} centavos` : ' (full)'}`);

        const response = await this._request('POST', `/payments/${transactionId}/refund`, payload);

        return this._buildPaymentResult(response);
    }

    /**
     * Query the current status of a transaction.
     *
     * @param {string} transactionId
     * @returns {Promise<{transactionId, status, responseCode, responseMessage, raw}>}
     */
    async getPaymentStatus(transactionId) {
        if (!transactionId) throw new CardNetError('transactionId es requerido para consultar');

        console.log(`[CardNet] Querying status for transaction: ${transactionId}`);

        const response = await this._request('GET', `/payments/${transactionId}`);

        return this._buildPaymentResult(response);
    }

    /**
     * Process a single-step sale (authorize + capture in one call).
     * This is the typical path for card-present or instant-charge scenarios.
     *
     * @param {object}  opts  - Same fields as createPayment
     * @returns {Promise<{transactionId, authorizationCode, status, responseCode, responseMessage, raw}>}
     */
    async processSale({
        amount,
        currency = 'DOP',
        cardNumber,
        cardExpMonth,
        cardExpYear,
        cardCvv,
        cardHolderName,
        description,
        orderId,
    }) {
        _requireFields({ amount, cardNumber, cardExpMonth, cardExpYear, cardCvv, cardHolderName });

        const amountInCentavos = _toCentavos(amount);

        const payload = {
            merchantId:   this.merchantId,
            merchantName: this.merchantName,
            amount:       amountInCentavos,
            currency:     currency.toUpperCase(),
            card: {
                number:     cardNumber.replace(/\s+/g, ''),
                expMonth:   cardExpMonth.toString().padStart(2, '0'),
                expYear:    _normaliseYear(cardExpYear),
                cvv:        cardCvv,
                holderName: cardHolderName,
            },
            description: description || 'Servicio de estacionamiento ParkingPro',
            orderId:     orderId || `PP-${Date.now()}`,
            type:        'SALE',
        };

        console.log(`[CardNet] Processing sale — orderId: ${payload.orderId}, amount: ${amountInCentavos} centavos`);

        const response = await this._request('POST', '/payments/sale', payload);

        return this._buildPaymentResult(response);
    }

    // -----------------------------------------------------------------------
    // Internal: response normalisation
    // -----------------------------------------------------------------------

    /**
     * Normalise a raw CardNet API response into a consistent result shape.
     *
     * @param {object} response - Raw parsed JSON from CardNet
     * @returns {{transactionId, authorizationCode, status, responseCode, responseMessage, raw}}
     */
    _buildPaymentResult(response) {
        const responseCode = response.responseCode || response.rc || '99';
        return {
            transactionId:     response.transactionId || response.id || null,
            authorizationCode: response.authorizationCode || response.authCode || null,
            status:            this._mapStatus(responseCode),
            responseCode,
            responseMessage:   response.responseMessage || response.message || 'Sin descripción',
            raw:               response,
        };
    }

    // -----------------------------------------------------------------------
    // Public: status mapping
    // -----------------------------------------------------------------------

    /**
     * Map a CardNet / ISO-8583 response code to the internal ParkingPro
     * payment status string.
     *
     * @param {string} responseCode
     * @returns {'paid'|'failed'|'pending'}
     */
    _mapStatus(responseCode) {
        if (!responseCode) return 'pending';
        return RESPONSE_CODE_MAP[String(responseCode).trim()] || 'failed';
    }

    // -----------------------------------------------------------------------
    // Public: card utilities
    // -----------------------------------------------------------------------

    /**
     * Validate a card number using the Luhn algorithm.
     *
     * @param {string} cardNumber - PAN (digits only or with spaces/dashes)
     * @returns {boolean}
     */
    validateCardNumber(cardNumber) {
        if (!cardNumber) return false;

        const digits = cardNumber.replace(/[\s\-]/g, '');

        if (!/^\d+$/.test(digits) || digits.length < 13 || digits.length > 19) {
            return false;
        }

        // Luhn algorithm
        let sum     = 0;
        let isEven  = false;

        for (let i = digits.length - 1; i >= 0; i--) {
            let d = parseInt(digits[i], 10);

            if (isEven) {
                d *= 2;
                if (d > 9) {
                    d -= 9;
                }
            }

            sum    += d;
            isEven  = !isEven;
        }

        return sum % 10 === 0;
    }

    /**
     * Detect the card brand from the PAN using leading-digit patterns.
     *
     * @param {string} cardNumber - PAN (digits only or with spaces)
     * @returns {'visa'|'mastercard'|'amex'|'discover'|'diners'|'unionpay'|'unknown'}
     */
    detectCardBrand(cardNumber) {
        if (!cardNumber) return 'unknown';

        const digits = cardNumber.replace(/\s+/g, '');

        // Visa: starts with 4
        if (/^4/.test(digits)) return 'visa';

        // Mastercard: 51-55 or 2221-2720
        if (/^5[1-5]/.test(digits)) return 'mastercard';
        if (/^2(22[1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720)/.test(digits)) return 'mastercard';

        // American Express: 34 or 37
        if (/^3[47]/.test(digits)) return 'amex';

        // Discover: 6011, 622126-622925, 644-649, 65
        if (/^(6011|65|64[4-9]|622(1(2[6-9]|[3-9]\d)|[2-8]\d{2}|9([01]\d|2[0-5])))/.test(digits)) {
            return 'discover';
        }

        // Diners Club: 300-305, 36, 38
        if (/^3(0[0-5]|[68])/.test(digits)) return 'diners';

        // UnionPay: 62 (broad match after Discover/Mastercard exclusions)
        if (/^62/.test(digits)) return 'unionpay';

        return 'unknown';
    }
}

// ---------------------------------------------------------------------------
// Private helpers (module-level, not on prototype)
// ---------------------------------------------------------------------------

/**
 * Convert DOP major units (e.g. 1500.75) to centavos integer (e.g. 150075).
 * Uses Math.round to avoid floating-point drift.
 * @param {number} amount
 * @returns {number}
 */
function _toCentavos(amount) {
    return Math.round(parseFloat(amount) * 100);
}

/**
 * Normalise a 2-digit or 4-digit year to the 2-digit form CardNet expects.
 * @param {string|number} year
 * @returns {string} Two-digit year string, e.g. '27'
 */
function _normaliseYear(year) {
    const str = String(year).trim();
    return str.length === 4 ? str.slice(-2) : str.padStart(2, '0');
}

/**
 * Throw a CardNetError listing any missing required fields.
 * @param {object} fields  - { fieldName: value, ... }
 */
function _requireFields(fields) {
    const missing = Object.entries(fields)
        .filter(([, v]) => v === null || v === undefined || v === '')
        .map(([k]) => k);

    if (missing.length > 0) {
        throw new CardNetError(
            `Campos requeridos faltantes: ${missing.join(', ')}`,
            'MISSING_FIELDS'
        );
    }
}

/**
 * Promise-based sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = new CardNetService();
module.exports.CardNetService = CardNetService;
module.exports.CardNetError   = CardNetError;
