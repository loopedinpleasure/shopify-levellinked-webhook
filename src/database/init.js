const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('../config');

class DatabaseInitializer {
    constructor() {
        this.dbPath = path.resolve(config.server.databasePath);
        this.db = null;
    }

    // Initialize database
    async init() {
        return new Promise((resolve, reject) => {
            // Ensure data directory exists
            const dataDir = path.dirname(this.dbPath);
            if (!require('fs').existsSync(dataDir)) {
                require('fs').mkdirSync(dataDir, { recursive: true });
            }

            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('❌ Database connection error:', err);
                    reject(err);
                    return;
                }

                console.log('✅ Database connected for initialization');
                resolve();
            });
        });
    }

    // Create tables
    async createTables() {
        const tables = [
            // Settings table
            `CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY,
                key TEXT UNIQUE,
                value TEXT
            )`,

            // Categories table
            `CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                emoji TEXT NOT NULL,
                shopify_collection_id TEXT,
                shopify_tags TEXT,
                fallback_category BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Member tracking table
            `CREATE TABLE IF NOT EXISTS member_tracking (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT UNIQUE NOT NULL,
                username TEXT,
                joined_at DATETIME NOT NULL,
                is_verified BOOLEAN DEFAULT FALSE,
                has_closed_dms_role BOOLEAN DEFAULT FALSE,
                welcome_dm_sent BOOLEAN DEFAULT FALSE,
                dm_sent_at DATETIME,
                opt_out_at DATETIME,
                still_in_server BOOLEAN DEFAULT TRUE,
                total_invites INTEGER DEFAULT 0,
                referral_rewards_earned INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Message queue table
            `CREATE TABLE IF NOT EXISTS message_queue (
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
            )`,

            // Embed templates table
            `CREATE TABLE IF NOT EXISTS embed_templates (
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
            )`,

            // Analytics table
            `CREATE TABLE IF NOT EXISTS analytics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date DATE DEFAULT CURRENT_DATE,
                metric_type TEXT NOT NULL,
                source_type TEXT,
                count INTEGER DEFAULT 1,
                revenue DECIMAL(10,2) DEFAULT 0,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Orders table
            `CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shopify_id TEXT UNIQUE,
                email TEXT,
                order_number TEXT UNIQUE,
                total_price DECIMAL(10,2),
                currency TEXT,
                financial_status TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Polls table
            `CREATE TABLE IF NOT EXISTS polls (
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
            )`,

            // Poll votes table
            `CREATE TABLE IF NOT EXISTS poll_votes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                poll_id INTEGER,
                user_id TEXT NOT NULL,
                option_index INTEGER NOT NULL,
                voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(poll_id, user_id)
            )`,

            // Giveaways table
            `CREATE TABLE IF NOT EXISTS giveaways (
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
            )`,

            // Giveaway entries table
            `CREATE TABLE IF NOT EXISTS giveaway_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER,
                user_id TEXT NOT NULL,
                entry_method TEXT DEFAULT 'reaction',
                entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(giveaway_id, user_id)
            )`,

            // Referral rewards table
            `CREATE TABLE IF NOT EXISTS referral_rewards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                invites_count INTEGER NOT NULL,
                reward_type TEXT NOT NULL,
                discount_code TEXT,
                redeemed BOOLEAN DEFAULT FALSE,
                redeemed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Processed orders tracking table (for offline sync)
            `CREATE TABLE IF NOT EXISTS processed_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shopify_order_id TEXT UNIQUE NOT NULL,
                order_number TEXT NOT NULL,
                processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                notification_sent BOOLEAN DEFAULT FALSE,
                sync_source TEXT DEFAULT 'webhook' -- 'webhook' or 'api_sync'
            )`
        ];

        for (const tableSql of tables) {
            await this.runSql(tableSql);
        }

        console.log('✅ All tables created successfully');
    }

    // Create indexes for performance
    async createIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_member_tracking_user_id ON member_tracking(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_member_tracking_joined_at ON member_tracking(joined_at)',
            'CREATE INDEX IF NOT EXISTS idx_member_tracking_verified ON member_tracking(is_verified)',
            'CREATE INDEX IF NOT EXISTS idx_member_tracking_closed_dms ON member_tracking(has_closed_dms_role)',
            'CREATE INDEX IF NOT EXISTS idx_message_queue_status ON message_queue(status)',
            'CREATE INDEX IF NOT EXISTS idx_message_queue_scheduled ON message_queue(scheduled_for)',
            'CREATE INDEX IF NOT EXISTS idx_message_queue_priority ON message_queue(priority)',
            'CREATE INDEX IF NOT EXISTS idx_analytics_date ON analytics(date)',
            'CREATE INDEX IF NOT EXISTS idx_analytics_metric ON analytics(metric_type)',
            'CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number)',
            'CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_processed_orders_id ON processed_orders(shopify_order_id)',
            'CREATE INDEX IF NOT EXISTS idx_processed_orders_number ON processed_orders(order_number)',
            'CREATE INDEX IF NOT EXISTS idx_polls_active ON polls(is_active)',
            'CREATE INDEX IF NOT EXISTS idx_giveaways_active ON giveaways(is_active)',
            'CREATE INDEX IF NOT EXISTS idx_referral_rewards_user ON referral_rewards(user_id)'
        ];

        for (const indexSql of indexes) {
            await this.runSql(indexSql);
        }

        console.log('✅ All indexes created successfully');
    }

    // Insert default data
    async insertDefaultData() {
        // Insert default settings
        const defaultSettings = [
            ['orders_enabled', 'true'],
            ['reviews_enabled', 'false'],
            ['auto_dm_enabled', 'false'], // DISABLED BY DEFAULT FOR SAFETY
            ['engagement_enabled', 'true'],
            ['analytics_enabled', 'true'],
            ['dm_delay_minutes', '65'],
            ['referral_tier_1', '5'],
            ['referral_tier_2', '10'],
            ['referral_tier_3', '15']
        ];

        for (const [key, value] of defaultSettings) {
            await this.runSql(
                'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
                [key, value]
            );
        }

        // Insert default categories
        const defaultCategories = [
            ['Adult Toys', '🪄', null, 'adult,toy,intimate,adult-toys', false],
            ['Accessories', '🛍️', null, 'accessory,accessories,addon', false]
        ];

        for (const [name, emoji, collectionId, tags, fallback] of defaultCategories) {
            await this.runSql(
                'INSERT OR IGNORE INTO categories (name, emoji, shopify_collection_id, shopify_tags, fallback_category) VALUES (?, ?, ?, ?, ?)',
                [name, emoji, collectionId, tags, fallback]
            );
        }

        // Insert default auto-DM template
        await this.runSql(`
            INSERT OR IGNORE INTO embed_templates 
            (name, template_type, title, description, color, button_text, button_url, is_active) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            'Default Welcome',
            'auto_dm',
            '🎉 Welcome to Level Linked!',
            'Thanks for joining our community! Check out our latest products and exclusive offers.',
            '#00ff00',
            'Visit Shop',
            'https://levellinked.myshopify.com',
            true
        ]);

        console.log('✅ Default data inserted successfully');
    }

    // Helper method to run SQL
    async runSql(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({
                    lastID: this.lastID,
                    changes: this.changes
                });
            });
        });
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('❌ Error closing database:', err);
                } else {
                    console.log('✅ Database initialization completed');
                }
            });
        }
    }
}

// Main initialization function
async function initializeDatabase() {
    const initializer = new DatabaseInitializer();
    
    try {
        console.log('🚀 Starting database initialization...');
        
        await initializer.init();
        await initializer.createTables();
        await initializer.createIndexes();
        await initializer.insertDefaultData();
        
        console.log('🎉 Database initialization completed successfully!');
        
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
        process.exit(1);
    } finally {
        initializer.close();
    }
}

// Run initialization if this file is executed directly
if (require.main === module) {
    initializeDatabase();
}

module.exports = { DatabaseInitializer, initializeDatabase };

