const db = require('../database/db');

class MessageQueue {
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;
        this.isProcessing = false;
        this.processingInterval = null;
    }

    // Add a message to the queue
    async addMessage(messageData) {
        try {
            const {
                type,           // 'order', 'auto_dm', 'custom_dm', 'custom_channel', 'poll', 'giveaway'
                target_type,    // 'channel', 'user', 'all_users', 'batch'
                target_id,      // channel_id, user_id, or batch_id
                message_data,   // JSON string with message content
                priority = 0,   // Higher = more priority
                scheduled_for = null // Optional future timestamp
            } = messageData;

            const query = `
                INSERT INTO message_queue (
                    type, target_type, target_id, message_data, 
                    status, priority, scheduled_for, created_at
                ) VALUES (?, ?, ?, ?, 'pending', ?, ?, datetime('now'))
            `;

            const scheduledTime = scheduled_for || new Date().toISOString();
            
            await db.run(query, [
                type, target_type, target_id, message_data, 
                priority, scheduledTime
            ]);

            console.log(`✅ Message queued: ${type} for ${target_type} ${target_id}`);
            
            // Start processing if not already running
            if (!this.isProcessing) {
                this.startProcessing();
            }

            return true;
        } catch (error) {
            console.error('❌ Failed to queue message:', error);
            return false;
        }
    }

    // Start the message processing loop
    startProcessing() {
        if (this.processingInterval) {
            return; // Already running
        }

        this.isProcessing = true;
        console.log('🚀 Starting message queue processor...');

        // Process messages every 30 seconds
        this.processingInterval = setInterval(async () => {
            await this.processQueue();
        }, 30000);

        // Also process immediately
        this.processQueue();
    }

    // Stop the message processing loop
    stopProcessing() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        this.isProcessing = false;
        console.log('⏹️ Message queue processor stopped');
    }

    // Process all pending messages in the queue
    async processQueue() {
        try {
            // Get pending messages, ordered by priority and creation time
            const query = `
                SELECT * FROM message_queue 
                WHERE status = 'pending' 
                AND (scheduled_for IS NULL OR scheduled_for <= datetime('now'))
                ORDER BY priority DESC, created_at ASC
                LIMIT 10
            `;

            const messages = await db.all(query);
            
            if (messages.length === 0) {
                return; // No messages to process
            }

            console.log(`📬 Processing ${messages.length} queued messages...`);

            for (const message of messages) {
                try {
                    await this.processMessage(message);
                } catch (error) {
                    console.error(`❌ Failed to process message ${message.id}:`, error);
                    
                    // Mark as failed if max attempts reached
                    if (message.attempts >= (message.max_attempts || 3)) {
                        await this.markMessageFailed(message.id, error.message);
                    } else {
                        // Increment attempt count
                        await this.incrementAttempts(message.id);
                    }
                }
            }

        } catch (error) {
            console.error('❌ Error processing message queue:', error);
        }
    }

    // Process a single message
    async processMessage(message) {
        try {
            console.log(`📤 Processing message ${message.id}: ${message.type} for ${message.target_type} ${message.target_id}`);

            let success = false;

            switch (message.type) {
                case 'order':
                    success = await this.sendOrderNotification(message);
                    break;

                case 'custom_dm':
                    success = await this.sendCustomDM(message);
                    break;
                case 'custom_channel':
                    success = await this.sendCustomChannelMessage(message);
                    break;
                default:
                    console.warn(`⚠️ Unknown message type: ${message.type}`);
                    success = false;
            }

            if (success) {
                await this.markMessageSent(message.id);
                console.log(`✅ Message ${message.id} sent successfully`);
            } else {
                throw new Error('Message sending failed');
            }

        } catch (error) {
            console.error(`❌ Failed to process message ${message.id}:`, error);
            throw error;
        }
    }

    // Send order notification to channel
    async sendOrderNotification(message) {
        try {
            const messageData = JSON.parse(message.message_data);
            const channel = await this.client.channels.fetch(message.target_id);
            
            if (!channel) {
                throw new Error('Channel not found');
            }

            const sentMessage = await channel.send(messageData);
            
            // Add automatic reactions after 15 seconds for order notifications
            setTimeout(async () => {
                try {
                    const { getOrderReactions } = require('../discord/embeds');
                    const reactions = getOrderReactions();
                    for (const reaction of reactions) {
                        await sentMessage.react(reaction);
                    }
                    console.log(`✅ Added ${reactions.length} reactions to order notification`);
                } catch (error) {
                    console.error('❌ Failed to add reactions:', error);
                }
            }, 15000); // 15 second delay
            
            return true;
        } catch (error) {
            console.error('❌ Failed to send order notification:', error);
            return false;
        }
    }



    // Send custom DM to user
    async sendCustomDM(message) {
        try {
            const messageData = JSON.parse(message.message_data);
            const user = await this.client.users.fetch(message.target_id);
            
            if (!user) {
                throw new Error('User not found');
            }

            await user.send(messageData);
            return true;
        } catch (error) {
            console.error('❌ Failed to send custom DM:', error);
            return false;
        }
    }

    // Send custom message to channel
    async sendCustomChannelMessage(message) {
        try {
            const messageData = JSON.parse(message.message_data);
            const channel = await this.client.channels.fetch(message.target_id);
            
            if (!channel) {
                throw new Error('Channel not found');
            }

            await channel.send(messageData);
            return true;
        } catch (error) {
            console.error('❌ Failed to send custom channel message:', error);
            return false;
        }
    }

    // Mark message as sent
    async markMessageSent(messageId) {
        const query = `
            UPDATE message_queue 
            SET status = 'sent', sent_at = datetime('now') 
            WHERE id = ?
        `;
        await db.run(query, [messageId]);
    }

    // Mark message as failed
    async markMessageFailed(messageId, errorMessage) {
        const query = `
            UPDATE message_queue 
            SET status = 'failed', error_message = ? 
            WHERE id = ?
        `;
        await db.run(query, [errorMessage, messageId]);
    }

    // Increment attempt count
    async incrementAttempts(messageId) {
        const query = `
            UPDATE message_queue 
            SET attempts = attempts + 1 
            WHERE id = ?
        `;
        await db.run(query, [messageId]);
    }

    // Get queue statistics
    async getQueueStats() {
        try {
            const stats = await db.get(`
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
                FROM message_queue
            `);
            
            return stats || { total: 0, pending: 0, sent: 0, failed: 0 };
        } catch (error) {
            console.error('❌ Failed to get queue stats:', error);
            return { total: 0, pending: 0, sent: 0, failed: 0 };
        }
    }

    // Clean up old messages (older than 30 days)
    async cleanupOldMessages() {
        try {
            const query = `
                DELETE FROM message_queue 
                WHERE created_at < datetime('now', '-30 days')
                AND status IN ('sent', 'failed')
            `;
            
            const result = await db.run(query);
            console.log(`🧹 Cleaned up ${result.changes} old messages`);
            
            return result.changes;
        } catch (error) {
            console.error('❌ Failed to cleanup old messages:', error);
            return 0;
        }
    }

    // Process any pending messages from when bot was offline
    async processOfflineMessages() {
        try {
            console.log('🔄 Processing messages that were queued while bot was offline...');
            
            const stats = await this.getQueueStats();
            console.log(`📊 Queue stats: ${stats.pending} pending, ${stats.sent} sent, ${stats.failed} failed`);
            
            if (stats.pending > 0) {
                console.log(`🚀 Starting to process ${stats.pending} pending messages...`);
                await this.processQueue();
            }
            
            // Schedule cleanup of old messages (daily at 3 AM)
            setInterval(() => {
                this.cleanupOldMessages();
            }, 24 * 60 * 60 * 1000);
            
        } catch (error) {
            console.error('❌ Failed to process offline messages:', error);
        }
    }
}

module.exports = MessageQueue;
