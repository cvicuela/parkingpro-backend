const QRCode = require('qrcode');

class QRCodeService {
    /**
     * Genera un QR code como Data URL (base64) para un ticket de entrada
     */
    async generateEntryQR(ticketData) {
        const payload = JSON.stringify({
            ticketId: ticketData.ticketId,
            plate: ticketData.plate,
            type: ticketData.accessType,
            entryTime: ticketData.entryTime,
            planName: ticketData.planName || null,
            customerName: ticketData.customerName || null
        });

        const qrDataUrl = await QRCode.toDataURL(payload, {
            width: 300,
            margin: 2,
            color: {
                dark: '#1e1b4b',
                light: '#ffffff'
            },
            errorCorrectionLevel: 'M'
        });

        return qrDataUrl;
    }

    /**
     * Genera un QR code como buffer PNG
     */
    async generateEntryQRBuffer(ticketData) {
        const payload = JSON.stringify({
            ticketId: ticketData.ticketId,
            plate: ticketData.plate,
            type: ticketData.accessType,
            entryTime: ticketData.entryTime
        });

        return await QRCode.toBuffer(payload, {
            width: 300,
            margin: 2,
            color: {
                dark: '#1e1b4b',
                light: '#ffffff'
            },
            errorCorrectionLevel: 'M'
        });
    }
}

module.exports = new QRCodeService();
