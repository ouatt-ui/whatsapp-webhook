const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = 'visionprotection2024';
const CRM_WEBHOOK_URL = 'https://hooks.visionprotection.app/leads/whatsapp';

// Vérification webhook Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Réception des messages WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    await axios.post(CRM_WEBHOOK_URL, req.body);
  } catch (e) {}
  res.sendStatus(200);
});

app.listen(3000, () => console.log('Webhook running on port 3000'));
