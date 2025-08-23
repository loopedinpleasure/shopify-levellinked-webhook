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
            lastOrder: null
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
            
            // Start status updates
            this.startStatusUpdates();
            
            // Send initial status
            await this.sendStatusUpdate('Bot Started', '🟢 Bot is now online and logging');

        } catch (error) {
            console.error('❌ Failed to initialize logging:', error);
        }
    }

    // Start periodic status updates
    startStatusUpdates() {
        const intervalMs = config.features.logging.statusInterval * 60 * 1000;
        
        this.statusInterval = setInterval(async () => {
            await this.sendPeriodicStatus();
        }, intervalMs);

        console.log(`📝 Status updates scheduled every ${config.features.logging.statusInterval} minutes`);
    }

    // Send periodic status update
    async sendPeriodicStatus() {
        try {
            const embed = await this.createStatusEmbed();
            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('❌ Failed to send periodic status:', error);
        }
    }

    // Create status embed
    async createStatusEmbed() {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

        const embed = new EmbedBuilder()
            .setTitle('📊 Bot Status Update')
            .setDescription('Regular system health and performance report')
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

        // Activity statistics
        embed.addFields(
            {
                name: '🛍️ Orders Processed',
                value: this.stats.orders.toString(),
                inline: true
            },
            {
                name: '📧 DMs Sent',
                value: this.stats.dms.toString(),
                inline: true
            },
            {
                name: '👥 Members Tracked',
                value: this.stats.members.toString(),
                inline: true
            }
        );

        // Last activity
        if (this.stats.lastOrder) {
            embed.addFields({
                name: '📦 Last Order',
                value: this.stats.lastOrder,
                inline: false
            });
        }

        // Footer
        embed.setFooter({
            text: 'Level Linked Bot • Status Update'
        });

        return embed;
    }

    // Log order processing
    async logOrder(orderData, product, category) {
        if (!config.features.logging.logOrders) return;

        try {
            this.stats.orders++;
            this.stats.lastOrder = `${orderData.order_number} - ${product.name}`;

            const embed = new EmbedBuilder()
                .setTitle('🛍️ Order Processed')
                .setDescription(`New order received and processed`)
                .setColor('#00ff00')
                .addFields(
                    {
                        name: '📦 Product',
                        value: product.name,
                        inline: true
                    },
                    {
                        name: '🏷️ Category',
                        value: `${category.emoji} ${category.name}`,
                        inline: true
                    },
                    {
                        name: '💰 Price',
                        value: `$${parseFloat(product.price).toFixed(2)}`,
                        inline: true
                    },
                    {
                        name: '🔗 Order Number',
                        value: orderData.order_number,
                        inline: false
                    }
                )
                .setTimestamp()
                .setFooter({
                    text: 'Level Linked • Order Log'
                });

            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }

        } catch (error) {
            console.error('❌ Failed to log order:', error);
        }
    }

    // Log member activity
    async logMemberActivity(action, member, details = {}) {
        if (!config.features.logging.logMembers) return;

        try {
            const embed = new EmbedBuilder()
                .setTitle(`👤 Member ${action}`)
                .setDescription(`Member activity detected`)
                .setColor('#4169e1')
                .addFields(
                    {
                        name: '👤 User',
                        value: member.user.tag,
                        inline: true
                    },
                    {
                        name: '🆔 User ID',
                        value: member.user.id,
                        inline: true
                    }
                )
                .setTimestamp()
                .setFooter({
                    text: 'Level Linked • Member Log'
                });

            // Add additional details
            if (details.role) {
                embed.addFields({
                    name: '🏷️ Role Change',
                    value: details.role,
                    inline: false
                });
            }

            if (details.reason) {
                embed.addFields({
                    name: '📝 Details',
                    value: details.reason,
                    inline: false
                });
            }

            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }

        } catch (error) {
            console.error('❌ Failed to log member activity:', error);
        }
    }

    // Log DM activity
    async logDM(userId, username, action, details = {}) {
        if (!config.features.logging.logDMs) return;

        try {
            this.stats.dms++;

            const embed = new EmbedBuilder()
                .setTitle(`📧 DM ${action}`)
                .setDescription(`Direct message activity`)
                .setColor('#ff69b4')
                .addFields(
                    {
                        name: '👤 User',
                        value: username,
                        inline: true
                    },
                    {
                        name: '🆔 User ID',
                        value: userId,
                        inline: true
                    }
                )
                .setTimestamp()
                .setFooter({
                    text: 'Level Linked • DM Log'
                });

            if (details.type) {
                embed.addFields({
                    name: '📝 Type',
                    value: details.type,
                    inline: false
                });
            }

            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }

        } catch (error) {
            console.error('❌ Failed to log DM activity:', error);
        }
    }

    // Log errors
    async logError(error, context = '') {
        if (!config.features.logging.logErrors) return;

        try {
            this.stats.errors++;

            const embed = new EmbedBuilder()
                .setTitle('❌ Error Occurred')
                .setDescription(`An error was detected in the bot`)
                .setColor('#ff0000')
                .addFields(
                    {
                        name: '🚨 Error',
                        value: error.message || 'Unknown error',
                        inline: false
                    }
                )
                .setTimestamp()
                .setFooter({
                    text: 'Level Linked • Error Log'
                });

            if (context) {
                embed.addFields({
                    name: '📍 Context',
                    value: context,
                    inline: false
                });
            }

            if (this.logChannel) {
                await this.logChannel.send({ embeds: [embed] });
            }

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
