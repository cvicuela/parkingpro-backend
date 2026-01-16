const express = require('express');
const router = express.Router();

router.post('/stripe', async (req, res) => {
    res.json({ received: true });
});

router.post('/twilio', async (req, res) => {
    res.json({ received: true });
});

module.exports = router;