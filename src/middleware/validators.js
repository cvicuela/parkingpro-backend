/**
 * Dominican Republic input validators.
 * Validates RNC, cédula, license plate, phone, and email formats.
 */

// ── RNC (Registro Nacional de Contribuyentes) ──────────────────────
// Business RNC: 9 digits (e.g. 130123456)
// Personal cédula: 11 digits with format XXX-XXXXXXX-X
function cleanDigits(str) {
    return (str || '').replace(/[-\s]/g, '');
}

function isValidRNC(rnc) {
    if (!rnc) return false;
    const clean = cleanDigits(rnc);
    return /^[0-9]{9}$/.test(clean);
}

function isValidCedula(cedula) {
    if (!cedula) return false;
    const clean = cleanDigits(cedula);
    // 11 digits, format XXX-XXXXXXX-X
    return /^[0-9]{11}$/.test(clean);
}

// Accepts either RNC (9) or cédula (11)
function isValidIdDocument(doc) {
    if (!doc) return false;
    const clean = cleanDigits(doc);
    return isValidRNC(doc) || isValidCedula(doc);
}

// ── License Plate (Dominican Republic) ─────────────────────────────
// Formats: A123456, AB12345, oficial, diplomática, temporal
function isValidPlate(plate) {
    if (!plate) return false;
    const p = plate.toUpperCase().replace(/[-\s]/g, '').trim();
    if (p.length < 3 || p.length > 8) return false;
    // Standard formats
    return (
        /^[A-Z][0-9]{6}$/.test(p) ||     // A123456 (most common)
        /^[A-Z]{2}[0-9]{5}$/.test(p) ||   // AB12345
        /^[A-Z]{2}[0-9]{4}$/.test(p) ||   // AB1234 (motorcycles)
        /^[OEGXL][0-9]{5,6}$/.test(p) ||  // Oficial, Exonerado, etc.
        /^[A-Z]{1,3}[0-9]{3,6}$/.test(p)  // General fallback
    );
}

function sanitizePlate(plate) {
    if (!plate) return '';
    return plate.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

// ── Phone (Dominican Republic) ─────────────────────────────────────
function isValidDRPhone(phone) {
    if (!phone) return false;
    const clean = phone.replace(/[-\s()]/g, '');
    // Dominican: 809, 829, 849 area codes
    return /^\+?1?8[024]9[0-9]{7}$/.test(clean) || /^\+?[1-9][0-9]{7,14}$/.test(clean);
}

// ── Email ──────────────────────────────────────────────────────────
function isValidEmail(email) {
    if (!email) return false;
    return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email.trim());
}

// ── Format helpers ─────────────────────────────────────────────────
function formatCedula(cedula) {
    const clean = cleanDigits(cedula);
    if (clean.length === 11) {
        return `${clean.slice(0, 3)}-${clean.slice(3, 10)}-${clean.slice(10)}`;
    }
    return cedula;
}

function formatRNC(rnc) {
    const clean = cleanDigits(rnc);
    if (clean.length === 9) {
        return `${clean.slice(0, 3)}-${clean.slice(3, 8)}-${clean.slice(8)}`;
    }
    return rnc;
}

// ── Express middleware factory ──────────────────────────────────────
/**
 * Creates a validation middleware.
 * @param {Object} rules - { fieldName: { validator: fn, message: string, optional: boolean } }
 * @returns Express middleware
 *
 * Example:
 *   validate({
 *     'body.rnc': { validator: isValidRNC, message: 'RNC inválido', optional: true },
 *     'body.plate': { validator: isValidPlate, message: 'Placa inválida' }
 *   })
 */
function validate(rules) {
    return (req, res, next) => {
        const errors = [];

        for (const [path, rule] of Object.entries(rules)) {
            const [source, field] = path.split('.');
            const value = (req[source] || {})[field];

            if (!value && rule.optional) continue;
            if (!value && !rule.optional) {
                errors.push({ field, message: rule.message || `${field} es requerido` });
                continue;
            }

            if (rule.validator && !rule.validator(value)) {
                errors.push({ field, message: rule.message || `${field} es inválido` });
            }

            // Apply transform if provided (e.g. sanitizePlate)
            if (rule.transform && value) {
                req[source][field] = rule.transform(value);
            }
        }

        if (errors.length > 0) {
            return res.status(400).json({
                error: 'Errores de validación',
                details: errors
            });
        }

        next();
    };
}

module.exports = {
    isValidRNC,
    isValidCedula,
    isValidIdDocument,
    isValidPlate,
    sanitizePlate,
    isValidDRPhone,
    isValidEmail,
    formatCedula,
    formatRNC,
    cleanDigits,
    validate
};
