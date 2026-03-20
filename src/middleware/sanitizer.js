/**
 * Input sanitization middleware.
 * - Strips HTML tags from string values
 * - Trims whitespace from string values
 * - Removes keys that start with '$' to prevent NoSQL injection
 * - Leaves non-string values (numbers, booleans, arrays) untouched
 */

/**
 * Recursively sanitize an object's string values and remove NoSQL injection keys.
 * @param {*} obj - The value to sanitize
 * @returns {*} Sanitized value
 */
function sanitizeValue(obj) {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === 'string') {
        // Strip HTML tags and trim whitespace
        return obj.replace(/<[^>]*>/g, '').trim();
    }

    if (Array.isArray(obj)) {
        return obj.map(sanitizeValue);
    }

    if (typeof obj === 'object') {
        const sanitized = {};
        for (const key of Object.keys(obj)) {
            // Skip keys starting with '$' to prevent NoSQL injection
            if (key.startsWith('$')) {
                continue;
            }
            sanitized[key] = sanitizeValue(obj[key]);
        }
        return sanitized;
    }

    // Numbers, booleans, etc. — leave untouched
    return obj;
}

/**
 * Express middleware that sanitizes req.body, req.query, and req.params.
 */
function sanitizer(req, res, next) {
    if (req.body && typeof req.body === 'object') {
        req.body = sanitizeValue(req.body);
    }

    if (req.query && typeof req.query === 'object') {
        req.query = sanitizeValue(req.query);
    }

    if (req.params && typeof req.params === 'object') {
        req.params = sanitizeValue(req.params);
    }

    next();
}

module.exports = sanitizer;
