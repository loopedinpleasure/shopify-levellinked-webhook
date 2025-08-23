const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config');

class DatabaseConnection {
    constructor() {
        this.dbPath = path.resolve(__dirname, '..', '..', config.server.databasePath);
        this.db = null;
        this.isInitialized = false;
    }

    async init() {
        if (this.isInitialized) return this.db;

        try {
            // Ensure data directory exists
            const dataDir = path.dirname(this.dbPath);
            if (!require('fs').existsSync(dataDir)) {
                require('fs').mkdirSync(dataDir, { recursive: true });
            }

            this.db = new Database(this.dbPath);
            
            // Enable foreign keys and better performance
            this.db.pragma('foreign_keys = ON');
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = 10000');
            this.db.pragma('temp_store = MEMORY');

            this.isInitialized = true;
            console.log('✅ Database connection established');
            return this.db;
        } catch (error) {
            console.error('❌ Database connection failed:', error);
            throw error;
        }
    }

    getConnection() {
        if (!this.isInitialized) {
            throw new Error('Database not initialized. Call init() first.');
        }
        return this.db;
    }

    // Helper methods for common operations
    async get(query, params = []) {
        const db = this.getConnection();
        try {
            return db.prepare(query).get(params);
        } catch (error) {
            console.error('Database get error:', error);
            throw error;
        }
    }

    async all(query, params = []) {
        const db = this.getConnection();
        try {
            return db.prepare(query).all(params);
        } catch (error) {
            console.error('Database all error:', error);
            throw error;
        }
    }

    async run(query, params = []) {
        const db = this.getConnection();
        try {
            const result = db.prepare(query).run(params);
            return result;
        } catch (error) {
            console.error('Database run error:', error);
            throw error;
        }
    }

    async transaction(callback) {
        const db = this.getConnection();
        try {
            db.prepare('BEGIN TRANSACTION').run();
            const result = await callback(db);
            db.prepare('COMMIT').run();
            return result;
        } catch (error) {
            db.prepare('ROLLBACK').run();
            throw error;
        }
    }

    // Specific methods for member tracking
    async trackMember(userId, username, isVerified = false, hasClosedDms = false) {
        const query = `
            INSERT OR REPLACE INTO member_tracking 
            (user_id, username, joined_at, is_verified, has_closed_dms_role, still_in_server) 
            VALUES (?, ?, datetime('now'), ?, ?, TRUE)
        `;
        return this.run(query, [userId, username, isVerified, hasClosedDms]);
    }

    async updateMemberStatus(userId, updates) {
        const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = Object.values(updates);
        const query = `UPDATE member_tracking SET ${setClause} WHERE user_id = ?`;
        return this.run(query, [...values, userId]);
    }

    async getMember(userId) {
        return this.get('SELECT * FROM member_tracking WHERE user_id = ?', [userId]);
    }

    async getMembersForAutoDM() {
        return this.all(`
            SELECT * FROM member_tracking 
            WHERE still_in_server = TRUE 
            AND has_closed_dms_role = FALSE 
            AND welcome_dm_sent = FALSE 
            AND is_verified = TRUE
            ORDER BY joined_at ASC
        `);
    }

    // Methods for message queue
    async addToQueue(messageData) {
        const query = `
            INSERT INTO message_queue 
            (type, target_type, target_id, message_data, priority, scheduled_for) 
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        return this.run(query, [
            messageData.type,
            messageData.target_type,
            messageData.target_id,
            JSON.stringify(messageData.message_data),
            messageData.priority || 0,
            messageData.scheduled_for || new Date().toISOString()
        ]);
    }

    async getPendingMessages() {
        return this.all(`
            SELECT * FROM message_queue 
            WHERE status = 'pending' 
            AND scheduled_for <= datetime('now')
            ORDER BY priority DESC, created_at ASC
        `);
    }

    async updateMessageStatus(messageId, status, errorMessage = null) {
        const query = `
            UPDATE message_queue 
            SET status = ?, sent_at = datetime('now'), error_message = ?
            WHERE id = ?
        `;
        return this.run(query, [status, errorMessage, messageId]);
    }

    // Methods for orders
    async trackOrder(orderData) {
        const query = `
            INSERT OR REPLACE INTO orders 
            (shopify_order_id, customer_email, order_number, total_price, currency, status) 
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        return this.run(query, [
            orderData.id,
            orderData.email,
            orderData.order_number,
            orderData.total_price,
            orderData.currency,
            orderData.financial_status
        ]);
    }

    async getOrder(shopifyOrderId) {
        return this.get('SELECT * FROM orders WHERE shopify_order_id = ?', [shopifyOrderId]);
    }

    // Methods for analytics
    async recordEvent(metricType, sourceType = null, metadata = null, revenue = 0) {
        const query = `
            INSERT INTO analytics (metric_type, source_type, metadata, revenue) 
            VALUES (?, ?, ?, ?)
        `;
        return this.run(query, [metricType, sourceType, metadata ? JSON.stringify(metadata) : null, revenue]);
    }

    async getDailyStats(date = new Date().toISOString().split('T')[0]) {
        return this.all(`
            SELECT metric_type, source_type, SUM(count) as total_count, SUM(revenue) as total_revenue
            FROM analytics 
            WHERE date = ? 
            GROUP BY metric_type, source_type
        `, [date]);
    }

    // Methods for categories
    async getCategories() {
        return this.all('SELECT * FROM categories ORDER BY name');
    }

    async addCategory(categoryData) {
        const query = `
            INSERT INTO categories (name, emoji, shopify_tags, fallback_category) 
            VALUES (?, ?, ?, ?)
        `;
        return this.run(query, [
            categoryData.name,
            categoryData.emoji,
            categoryData.shopifyTags,
            categoryData.fallback || false
        ]);
    }

    // Methods for embed templates
    async getActiveTemplate(templateType) {
        return this.get(`
            SELECT * FROM embed_templates 
            WHERE template_type = ? AND is_active = TRUE
        `, [templateType]);
    }

    async updateTemplateUsage(templateId) {
        return this.run(`
            UPDATE embed_templates 
            SET usage_count = usage_count + 1, updated_at = datetime('now')
            WHERE id = ?
        `, [templateId]);
    }

    close() {
        if (this.db) {
            this.db.close();
            this.isInitialized = false;
        }
    }
}

// Create a singleton instance
const db = new DatabaseConnection();

module.exports = db;
