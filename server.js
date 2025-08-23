const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());

// Basic route to confirm server is running
app.get('/', (req, res) => {
  res.send('Shopify Webhook Server is running!');
});

// Shopify webhook endpoint
app.post('/webhooks/shopify', (req, res) => {
  console.log('Received webhook from Shopify:');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  
  // TODO: Verify webhook signature
  // TODO: Send to Discord
  
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});