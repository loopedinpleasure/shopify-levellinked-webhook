const db = require('./db');
const config = require('../config');

async function initializeDatabase() {
    try {
        console.log('🗄️ Initializing database...');

        // Initialize database connection
        const database = await db.init();

        // Create tables
        await createTables(database);
        console.log('✅ Tables created');

        // Insert default data
        await insertDefaultData(database);
        console.log('✅ Default data inserted');

        console.log('🎉 Database initialization complete!');
        return true;

    } catch (error) {
        console.error('❌ Database initialization failed:', error);
        throw error;
    }
}

async function createTables(database) {
    // Settings table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE NOT NULL,
            value TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Categories table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            emoji TEXT NOT NULL,
            shopify_collection_id TEXT,
            shopify_tags TEXT,
            fallback_category BOOLEAN DEFAULT FALSE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Member tracking table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS member_tracking (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT UNIQUE NOT NULL,
            username TEXT NOT NULL,
            joined_at DATETIME NOT NULL,
            is_verified BOOLEAN DEFAULT FALSE,
            has_closed_dms_role BOOLEAN DEFAULT FALSE,
            welcome_dm_sent BOOLEAN DEFAULT FALSE,
            dm_sent_at DATETIME,
            opt_out_at DATETIME,
            still_in_server BOOLEAN DEFAULT TRUE,
            total_invites INTEGER DEFAULT 0,
            referral_rewards_earned INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Message queue table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS message_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT,
            message_data TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 3,
            priority INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            scheduled_for DATETIME DEFAULT CURRENT_TIMESTAMP,
            sent_at DATETIME,
            error_message TEXT
        )
    `).run();

    // Embed templates table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS embed_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            template_type TEXT NOT NULL,
            title TEXT,
            description TEXT,
            color TEXT DEFAULT '#00ff00',
            image_url TEXT,
            thumbnail_url TEXT,
            footer_text TEXT,
            button_text TEXT,
            button_url TEXT,
            is_active BOOLEAN DEFAULT FALSE,
            usage_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Analytics table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS analytics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date DATE DEFAULT CURRENT_DATE,
            metric_type TEXT NOT NULL,
            source_type TEXT,
            count INTEGER DEFAULT 1,
            revenue DECIMAL(10,2) DEFAULT 0,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Orders table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shopify_order_id TEXT UNIQUE NOT NULL,
            customer_email TEXT,
            order_number TEXT NOT NULL,
            total_price DECIMAL(10,2),
            currency TEXT DEFAULT 'USD',
            status TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Polls table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS polls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            options TEXT NOT NULL,
            channel_id TEXT,
            message_id TEXT,
            created_by TEXT NOT NULL,
            votes_count INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            ends_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Poll votes table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS poll_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            poll_id INTEGER REFERENCES polls(id),
            user_id TEXT NOT NULL,
            option_index INTEGER NOT NULL,
            voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(poll_id, user_id)
        )
    `).run();

    // Giveaways table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS giveaways (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            prize_type TEXT NOT NULL,
            prize_value TEXT,
            channel_id TEXT,
            message_id TEXT,
            created_by TEXT NOT NULL,
            entries_count INTEGER DEFAULT 0,
            winner_user_id TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            ends_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Giveaway entries table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS giveaway_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            giveaway_id INTEGER REFERENCES giveaways(id),
            user_id TEXT NOT NULL,
            entry_method TEXT DEFAULT 'reaction',
            entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(giveaway_id, user_id)
        )
    `).run();

    // Referral rewards table
    database.prepare(`
        CREATE TABLE IF NOT EXISTS referral_rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            invites_count INTEGER NOT NULL,
            reward_type TEXT NOT NULL,
            discount_code TEXT,
            redeemed BOOLEAN DEFAULT FALSE,
            redeemed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Create indexes for better performance
    database.prepare('CREATE INDEX IF NOT EXISTS idx_member_tracking_user_id ON member_tracking(user_id)').run();
    database.prepare('CREATE INDEX IF NOT EXISTS idx_member_tracking_still_in_server ON member_tracking(still_in_server)').run();
    database.prepare('CREATE INDEX IF NOT EXISTS idx_message_queue_status ON message_queue(status)').run();
    database.prepare('CREATE INDEX IF NOT EXISTS idx_message_queue_scheduled_for ON message_queue(scheduled_for)').run();
    database.prepare('CREATE INDEX IF NOT EXISTS idx_analytics_date ON analytics(date)').run();
    database.prepare('CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id ON orders(shopify_order_id)').run();
    database.prepare('CREATE INDEX IF NOT EXISTS idx_embed_templates_type ON embed_templates(template_type)').run();
    database.prepare('CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name)').run();

    console.log('✅ Indexes created');
}

async function insertDefaultData(database) {
    // Insert default settings
    const defaultSettings = [
        ['orders_enabled', 'true'],
        ['reviews_enabled', 'false'],
        ['auto_dm_enabled', 'true'],
        ['engagement_enabled', 'true'],
        ['analytics_enabled', 'true'],
        ['dm_delay_minutes', config.features.autoDm.delayMinutes.toString()],
        ['dm_max_per_hour', config.features.autoDm.maxPerHour.toString()],
        ['referral_tier_1', '5'],
        ['referral_tier_2', '10'],
        ['referral_tier_3', '15']
    ];

    for (const [key, value] of defaultSettings) {
        database.prepare(`
            INSERT OR REPLACE INTO settings (key, value) 
            VALUES (?, ?)
        `).run([key, value]);
    }

    // Insert default categories
    for (const category of config.defaultCategories) {
        database.prepare(`
            INSERT OR REPLACE INTO categories (name, emoji, shopify_tags, fallback_category) 
            VALUES (?, ?, ?, ?)
        `).run([category.name, category.emoji, category.shopifyTags, category.fallback]);
    }

    // Insert a general fallback category
    database.prepare(`
        INSERT OR REPLACE INTO categories (name, emoji, shopify_tags, fallback_category) 
        VALUES ('General', '🛒', '', TRUE)
    `).run();

    // Insert default auto-DM template
    const defaultTemplate = {
        name: 'Welcome Message',
        template_type: 'auto_dm',
        title: '🎉 Welcome to Level Linked!',
        description: 'Thanks for joining our community! Check out our latest products and exclusive offers.',
        color: '#00ff00',
        button_text: 'Visit Shop',
        button_url: `https://${config.shopify.shopUrl}`,
        is_active: true
    };

    database.prepare(`
        INSERT OR REPLACE INTO embed_templates 
        (name, template_type, title, description, color, button_text, button_url, is_active) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run([
        defaultTemplate.name,
        defaultTemplate.template_type,
        defaultTemplate.title,
        defaultTemplate.description,
        defaultTemplate.color,
        defaultTemplate.button_text,
        defaultTemplate.button_url,
        defaultTemplate.is_active
    ]);

    console.log('✅ Default data inserted');
}

// Export the initialization function
module.exports = { initializeDatabase };

// If this file is run directly, initialize the database
if (require.main === module) {
    initializeDatabase()
        .then(() => {
            console.log('✅ Database initialization completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Database initialization failed:', error);
            process.exit(1);
        });
}
