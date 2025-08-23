require('dotenv').config({ path: '../.env' });

module.exports = {
    // Discord Configuration
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        guildId: process.env.GUILD_ID || '1378340070305828956',
        serverOwnerId: process.env.SERVER_OWNER_ID,
        notificationChannelId: process.env.NOTIFICATION_CHANNEL_ID || '1396453757922971741',
        adminChannelId: process.env.ADMIN_CHANNEL_ID || '1408813204519522444',
        logChannelId: process.env.LOG_CHANNEL_ID || '1408813204519522444', // Same as admin for now
        closedDmsRoleId: process.env.CLOSED_DMS_ROLE_ID || '1379198285591609385',
        verifiedRoleId: process.env.VERIFIED_ROLE_ID
    },

    // Shopify Configuration
    shopify: {
        shopUrl: process.env.SHOPIFY_SHOP_URL || 'levellinked.myshopify.com',
        accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
        webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET
    },

    // Bot Features
    features: {
        autoDm: {
            enabled: process.env.ENABLE_AUTO_DM !== 'false',
            delayMinutes: parseInt(process.env.DM_DELAY_MINUTES) || 65,
            maxPerHour: parseInt(process.env.DM_MAX_PER_HOUR) || 20,
            batchSize: parseInt(process.env.DM_BATCH_SIZE) || 50,
            batchDelay: parseInt(process.env.DM_BATCH_DELAY) || 1000
        },
        orders: {
            enabled: process.env.ENABLE_ORDERS !== 'false',
            showCustomerName: false, // Always show "Someone"
            showOrderTotal: false,
            showShippingAddress: false
        },
        engagement: {
            enabled: process.env.ENABLE_ENGAGEMENT !== 'false'
        },
        analytics: {
            enabled: process.env.ENABLE_ANALYTICS !== 'false'
        },
        logging: {
            enabled: process.env.ENABLE_LOGGING !== 'false',
            statusInterval: parseInt(process.env.LOG_STATUS_INTERVAL) || 30, // 30 minutes
            logLevel: process.env.LOG_LEVEL || 'detailed', // basic, detailed, errors
            logOrders: process.env.LOG_ORDERS !== 'false',
            logMembers: process.env.LOG_MEMBERS !== 'false',
            logDMs: process.env.LOG_DMS !== 'false',
            logErrors: process.env.LOG_ERRORS !== 'false'
        }
    },

    // Server Configuration
    server: {
        port: parseInt(process.env.PORT) || 10000,
        databasePath: process.env.DATABASE_URL || './data/bot.db',
        environment: process.env.NODE_ENV || 'development'
    },

    // Default Categories
    defaultCategories: [
        {
            name: 'Adult Toys',
            emoji: '🪄',
            shopifyTags: 'adult,toy,intimate,adult-toys',
            fallback: false
        },
        {
            name: 'Accessories',
            emoji: '🛍️',
            shopifyTags: 'accessory,accessories,addon',
            fallback: false
        }
    ]
};
