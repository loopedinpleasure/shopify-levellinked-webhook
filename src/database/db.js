const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('../config');

class Database {
    constructor() {
        this.db = null;
        this.dbPath = path.resolve(config.server.databasePath);
    }

    // Initialize database connection
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

                console.log('✅ Database connected successfully');
                
                // Enable foreign keys and other optimizations
                this.db.run('PRAGMA foreign_keys = ON');
                this.db.run('PRAGMA journal_mode = WAL');
                this.db.run('PRAGMA synchronous = NORMAL');
                this.db.run('PRAGMA cache_size = 10000');
                this.db.run('PRAGMA temp_store = MEMORY');
                
                resolve();
            });
        });
    }

    // Generic database methods
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows);
            });
        });
    }

    run(sql, params = []) {
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

    // Transaction support
    async transaction(operations) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');
                
                try {
                    operations();
                    this.db.run('COMMIT', (err) => {
                        if (err) {
                            this.db.run('ROLLBACK');
                            reject(err);
                            return;
                        }
                        resolve();
                    });
                } catch (error) {
                    this.db.run('ROLLBACK');
                    reject(error);
                }
            });
        });
    }

    // Member tracking methods
    async trackMember(userId, username, isVerified, hasClosedDms) {
        const sql = `
            INSERT OR REPLACE INTO member_tracking 
            (user_id, username, joined_at, is_verified, has_closed_dms_role, still_in_server) 
            VALUES (?, ?, datetime('now'), ?, ?, TRUE)
        `;
        return await this.run(sql, [userId, username, isVerified, hasClosedDms]);
    }

    async updateMemberStatus(userId, updates) {
        const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = Object.values(updates);
        const sql = `UPDATE member_tracking SET ${setClause} WHERE user_id = ?`;
        return await this.run(sql, [...values, userId]);
    }

    async getMember(userId) {
        return await this.get('SELECT * FROM member_tracking WHERE user_id = ?', [userId]);
    }

    async getMembersForAutoDM() {
        return await this.all(`
            SELECT user_id FROM member_tracking 
            WHERE still_in_server = TRUE 
            AND has_closed_dms_role = FALSE 
            AND welcome_dm_sent = FALSE 
            AND is_verified = TRUE
            ORDER BY joined_at ASC
        `);
    }

    // Order tracking methods
    async trackOrder(orderData) {
        const sql = `
            INSERT OR REPLACE INTO orders 
            (id, email, order_number, total_price, currency, financial_status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `;
        return await this.run(sql, [
            orderData.id,
            orderData.email,
            orderData.order_number,
            orderData.total_price,
            orderData.currency,
            orderData.financial_status
        ]);
    }

    // Analytics methods
    async recordEvent(metricType, sourceType, metadata = null, revenue = 0) {
        const sql = `
            INSERT INTO analytics 
            (metric_type, source_type, count, revenue, metadata, created_at) 
            VALUES (?, ?, 1, ?, ?, datetime('now'))
        `;
        return await this.run(sql, [metricType, sourceType, revenue, metadata ? JSON.stringify(metadata) : null]);
    }

    async getDailyStats(date) {
        return await this.all(`
            SELECT metric_type, SUM(count) as total_count, SUM(revenue) as total_revenue
            FROM analytics 
            WHERE date(created_at) = ? 
            GROUP BY metric_type
        `, [date]);
    }

    // Category methods
    async getCategories() {
        return await this.all('SELECT * FROM categories ORDER BY name');
    }

    // Template methods
    async getActiveTemplate(templateType) {
        return await this.get(`
            SELECT * FROM embed_templates 
            WHERE template_type = ? AND is_active = TRUE 
            ORDER BY usage_count ASC 
            LIMIT 1
        `, [templateType]);
    }

    async updateTemplateUsage(templateId) {
        return await this.run(`
            UPDATE embed_templates 
            SET usage_count = usage_count + 1, updated_at = datetime('now') 
            WHERE id = ?
        `, [templateId]);
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('❌ Error closing database:', err);
                } else {
                    console.log('✅ Database connection closed');
                }
            });
        }
    }
}

// Create and export database instance
const db = new Database();
module.exports = db;
