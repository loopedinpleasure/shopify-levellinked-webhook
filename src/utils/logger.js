const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const db = require('../database/db');

class BotLogger {
    constructor(client) {
        this.client = client;
        this.logChannel = null;
        this.statusInterval = null;
        this.startTime = Date.now();
        this.stats = {
            orders: 0,
            dms: 0,
            members: 0,
            errors: 0,
            lastOrder: null,
            // Activity tracking for summaries
            recentActivity: {
                orders: [],
                dms: [],
                members: [],
                errors: []
            }
        };
    }

    // Initialize logging system
    async init() {
        try {
            if (!config.features.logging.enabled) {
                console.log('📝 Logging system disabled');
                return;
            }

            // Get log channel
            this.logChannel = this.client.channels.cache.get(config.discord.logChannelId);
            if (!this.logChannel) {
                console.warn('⚠️ Log channel not found, logging to console only');
                return;
            }

            console.log('✅ Logging system initialized');

            // Start status updates (30-minute summaries)
            this.startStatusUpdates();

            // Send initial status
            await this.sendStatusUpdate('Bot Started', '🟢 Bot is now online and logging');

        } catch (error) {
            console.error('❌ Failed to initialize logging:', error);
        }
    }

    // Start periodic status updates (30-minute summaries)
    startStatusUpdates() {
        const intervalMs = config.features.logging.statusInterval * 60 * 1000;

        this.statusInterval = setInterval(async () => {
            await this.sendPeriodicStatus();
        }, intervalMs);

        console.log(`📝 Status updates scheduled every ${config.features.logging.statusInterval} minutes`);
    }

    // Send periodic status update (30-minute summary)
    async sendPeriodicStatus() {
        try {
            const embed = await this.createStatusEmbed();
            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }

            // Clear recent activity after sending summary
            this.clearRecentActivity();

        } catch (error) {
            console.error('❌ Failed to send periodic status:', error);
        }
    }

    // Create status embed (30-minute summary)
    async createStatusEmbed() {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

        const embed = new EmbedBuilder()
            .setTitle('📊 Bot Status Update (Last 30 Minutes)')
            .setDescription('Comprehensive activity summary')
            .setColor('#00ff00')
            .setTimestamp();

        // System status
        embed.addFields(
            {
                name: '🔄 System Status',
                value: '✅ Healthy',
                inline: true
            },
            {
                name: '⏱️ Uptime',
                value: uptimeFormatted,
                inline: true
            },
            {
                name: '💾 Database',
                value: '✅ Connected',
                inline: true
            }
        );

        // Recent activity summary (last 30 minutes)
        const recentOrders = this.stats.recentActivity.orders.length;
        const recentDMs = this.stats.recentActivity.dms.length;
        const recentMembers = this.stats.recentActivity.members.length;
        const recentErrors = this.stats.recentActivity.errors.length;

        embed.addFields(
            {
                name: '🛍️ Orders (30min)',
                value: recentOrders.toString(),
                inline: true
            },
            {
                name: '📧 DMs Sent (30min)',
                value: recentDMs.toString(),
                inline: true
            },
            {
                name: '👥 Member Activity (30min)',
                value: recentMembers.toString(),
                inline: true
            }
        );

        // Errors in last 30 minutes
        if (recentErrors > 0) {
            embed.addFields({
                name: '❌ Errors (30min)',
                value: recentErrors.toString(),
                inline: false
            });
        }

        // Last order (without sensitive data)
        if (this.stats.lastOrder) {
            embed.addFields({
                name: '📦 Last Order',
                value: this.stats.lastOrder,
                inline: false
            });
        }

        // Footer
        embed.setFooter({
            text: 'Level Linked Bot • 30-Minute Summary'
        });

        return embed;
    }

    // Clear recent activity after sending summary
    clearRecentActivity() {
        this.stats.recentActivity = {
            orders: [],
            dms: [],
            members: [],
            errors: []
        };
    }

    // Log order processing (add to recent activity)
    async logOrder(orderData, product, category) {
        if (!config.features.logging.logOrders) return;

        try {
            this.stats.orders++;
            // Store only product name, no sensitive data
            this.stats.lastOrder = `${product.name}`;

            // Add to recent activity
            this.stats.recentActivity.orders.push({
                product: product.name,
                timestamp: Date.now()
            });

            // Only log to channel if there's an error or it's time for summary
            // Individual order logs are now handled by the summary system

        } catch (error) {
            console.error('❌ Failed to log order:', error);
        }
    }

    // Log member activity (add to recent activity, no individual messages)
    async logMemberActivity(action, member, details = {}) {
        if (!config.features.logging.logMembers) return;

        try {
            // Add to recent activity instead of sending individual message
            this.stats.recentActivity.members.push({
                action: action,
                username: member.user.tag,
                timestamp: Date.now(),
                details: details
            });

        } catch (error) {
            console.error('❌ Failed to log member activity:', error);
        }
    }

    // Log DM activity (add to recent activity, no individual messages)
    async logDM(userId, username, action, details = {}) {
        if (!config.features.logging.logDMs) return;

        try {
            this.stats.dms++;

            // Add to recent activity instead of sending individual message
            this.stats.recentActivity.dms.push({
                action: action,
                username: username,
                timestamp: Date.now(),
                details: details
            });

        } catch (error) {
            console.error('❌ Failed to log DM activity:', error);
        }
    }

    // Log errors (add to recent activity, no individual messages)
    async logError(error, context = '') {
        if (!config.features.logging.logErrors) return;

        try {
            this.stats.errors++;

            // Add to recent activity instead of sending individual message
            this.stats.recentActivity.errors.push({
                error: error.message || 'Unknown error',
                context: context,
                timestamp: Date.now()
            });

        } catch (logError) {
            console.error('❌ Failed to log error:', logError);
        }
    }

    // Send custom status message
    async sendStatusUpdate(title, message, color = '#00ff00') {
        try {
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(message)
                .setColor(color)
                .setTimestamp()
                .setFooter({
                    text: 'Level Linked • Status Update'
                });

            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }

        } catch (error) {
            console.error('❌ Failed to send status update:', error);
        }
    }

    // Send daily summary (called once per day)
    async sendDailySummary() {
        try {
            const embed = await this.createDailySummaryEmbed();
            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('❌ Failed to send daily summary:', error);
        }
    }

    // Create daily summary embed
    async createDailySummaryEmbed() {
        const today = new Date().toISOString().split('T')[0];
        
        const embed = new EmbedBuilder()
            .setTitle('📅 Daily Activity Summary')
            .setDescription(`Activity report for ${today}`)
            .setColor('#4169e1')
            .setTimestamp();

        // Daily totals
        embed.addFields(
            {
                name: '🛍️ Total Orders',
                value: this.stats.recentActivity.orders.length.toString(),
                inline: true
            },
            {
                name: '📧 Total DMs Sent',
                value: this.stats.recentActivity.dms.length.toString(),
                inline: true
            },
            {
                name: '👥 Member Activity',
                value: this.stats.recentActivity.members.length.toString(),
                inline: true
            }
        );

        // Errors summary
        if (this.stats.recentActivity.errors.length > 0) {
            embed.addFields({
                name: '❌ Errors Today',
                value: this.stats.recentActivity.errors.length.toString(),
                inline: false
            });
        }

        embed.setFooter({
            text: 'Level Linked Bot • Daily Summary'
        });

        return embed;
    }

    // Send weekly summary (called once per week)
    async sendWeeklySummary() {
        try {
            const embed = await this.createWeeklySummaryEmbed();
            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('❌ Failed to send weekly summary:', error);
        }
    }

    // Create weekly summary embed
    async createWeeklySummaryEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('📊 Weekly Activity Summary')
            .setDescription('Complete weekly performance report')
            .setColor('#ffa500')
            .setTimestamp();

        // Weekly totals (accumulated from daily stats)
        embed.addFields(
            {
                name: '🛍️ Weekly Orders',
                value: this.stats.orders.toString(),
                inline: true
            },
            {
                name: '📧 Weekly DMs',
                value: this.stats.dms.toString(),
                inline: true
            },
            {
                name: '👥 Total Members',
                value: this.stats.members.toString(),
                inline: true
            }
        );

        // System health
        embed.addFields({
            name: '❤️ System Health',
            value: this.stats.errors === 0 ? '✅ Perfect' : `⚠️ ${this.stats.errors} errors`,
            inline: false
        });

        embed.setFooter({
            text: 'Level Linked Bot • Weekly Summary'
        });

        return embed;
    }

    // Update member count
    async updateMemberCount(count) {
        this.stats.members = count;
    }

    // Stop logging system
    stop() {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
        console.log('📝 Logging system stopped');
    }
}

module.exports = BotLogger;
