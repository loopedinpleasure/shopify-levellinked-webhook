const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Discord bot setup
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// Your Discord bot token (we'll add this to environment variables)
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID || '1396453757922971741';

// Webhook secret from Shopify
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Shopify webhook endpoint
app.post('/webhooks/shopify', async (req, res) => {
    try {
        // Verify webhook signature
        const signature = req.headers['x-shopify-hmac-sha256'];
        if (!verifyWebhook(req.body, signature)) {
            console.error('Invalid webhook signature');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const orderData = req.body;
        console.log('📦 Order received:', orderData.order_number);

        // Send to Discord
        await sendOrderToDiscord(orderData);

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Verify Shopify webhook
function verifyWebhook(body, signature) {
    if (!WEBHOOK_SECRET) return true; // Skip verification if no secret
    
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(JSON.stringify(body), 'utf8');
    const expectedSignature = 'sha256=' + hmac.digest('hex');
    
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

// Send order to Discord
async function sendOrderToDiscord(orderData) {
    try {
        const channel = client.channels.cache.get(NOTIFICATION_CHANNEL_ID);
        if (!channel) {
            console.error('Discord channel not found');
            return;
        }

        // Create order embed
        const embed = new EmbedBuilder()
            .setTitle(`🛍️ Someone ordered ${orderData.line_items?.[0]?.name || 'a product'}!`)
            .setDescription('New order received and accepted!')
            .setColor('#00ff00')
            .setTimestamp();

        // Add product details if available
        if (orderData.line_items && orderData.line_items.length > 0) {
            const product = orderData.line_items[0];
            embed.addFields(
                { name: '📦 Product', value: product.name, inline: true },
                { name: '💰 Price', value: `$${parseFloat(product.price).toFixed(2)}`, inline: true }
            );
        }

        await channel.send({ embeds: [embed] });
        console.log('✅ Order sent to Discord');
    } catch (error) {
        console.error('Failed to send to Discord:', error);
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        discord: client.user ? 'connected' : 'disconnected'
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook server running on port ${PORT}`);
});

// Discord bot ready
client.once('ready', () => {
    console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

// Login to Discord
client.login(DISCORD_TOKEN);