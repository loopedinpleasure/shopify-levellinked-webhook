const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const config = require('./config');
const db = require('./database/db');
const ShopifyWebhooks = require('./shopify/webhooks');
const BotLogger = require('./utils/logger');
const { createPrimaryPlatformEmbed, createEngagementPlatformEmbed } = require('./discord/embeds');

class ShopifyDiscordBot {
    constructor() {
        // Initialize Discord client with all required intents
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildInvites,
                GatewayIntentBits.MessageContent
            ]
        });

        // Initialize Express server for webhooks
        this.app = express();
        this.app.use(express.json());

        // Initialize Shopify webhooks handler
        this.shopifyWebhooks = null;

        // Initialize logger
        this.logger = null;

        // Bot state
        this.isReady = false;
        this.startTime = Date.now();

        // Setup event handlers
        this.setupEventHandlers();
        this.setupExpressRoutes();
    }

    // Setup Discord event handlers
    setupEventHandlers() {
        // Bot ready event
        this.client.once(Events.ClientReady, async () => {
            console.log(`🤖 Bot logged in as ${this.client.user.tag}`);
            await this.initializeBot();
        });

        // Member join event
        this.client.on(Events.GuildMemberAdd, async (member) => {
            await this.trackNewMember(member);
        });

        // Member leave event
        this.client.on(Events.GuildMemberRemove, async (member) => {
            await this.markMemberAsLeft(member.user.id);
        });

        // Member update event (role changes)
        this.client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
            await this.checkRoleChanges(oldMember, newMember);
        });

        // Button interactions
        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (interaction.isButton()) {
                await this.handleButtonInteraction(interaction);
            }
        });
    }

    // Setup Express routes for Shopify webhooks
    setupExpressRoutes() {
        // Health check endpoint
        this.app.get('/health', async (req, res) => {
            try {
                const healthData = await this.getHealthStatus();
                res.json(healthData);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Shopify webhook endpoint
        this.app.post('/webhook', async (req, res) => {
            try {
                const signature = req.headers['x-shopify-hmac-sha256'];
                const topic = req.headers['x-shopify-topic'];

                if (!signature || !topic) {
                    console.warn('❌ Missing webhook headers');
                    return res.status(400).json({ error: 'Missing required headers' });
                }

                if (!this.shopifyWebhooks) {
                    console.warn('❌ Bot not ready yet');
                    return res.status(503).json({ error: 'Bot not ready' });
                }

                const result = await this.shopifyWebhooks.handleWebhook(topic, req.body, signature);
                
                if (result.success) {
                    res.status(200).json({ success: true });
                } else {
                    res.status(400).json({ error: result.error });
                }
            } catch (error) {
                console.error('❌ Webhook error:', error);
                if (this.logger) {
                    await this.logger.logError(error, 'Webhook processing');
                }
                res.status(500).json({ error: error.message });
            }
        });

        // Catch-all route
        this.app.use('*', (req, res) => {
            res.status(404).json({ error: 'Not found' });
        });
    }

    // Initialize bot after Discord connection
    async initializeBot() {
        try {
            console.log('🚀 Initializing bot...');

            // Initialize database
            await db.init();
            console.log('✅ Database initialized');

            // Initialize logger
            this.logger = new BotLogger(this.client);
            await this.logger.init();
            console.log('✅ Logger initialized');

            // Initialize Shopify webhooks
            this.shopifyWebhooks = new ShopifyWebhooks(this.client, this.logger);
            console.log('✅ Shopify webhooks initialized');

            // Create admin panels
            await this.createAdminPanels();
            console.log('✅ Admin panels created');

            // Start auto-DM processor
            this.startAutoDMProcessor();
            console.log('✅ Auto-DM processor started');

            // Update member count for logging
            await this.updateMemberCountForLogging();

            // Mark bot as ready
            this.isReady = true;
            console.log('🎉 Bot fully initialized and ready!');

        } catch (error) {
            console.error('❌ Bot initialization failed:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Bot initialization');
            }
            process.exit(1);
        }
    }

    // Update member count for logging
    async updateMemberCountForLogging() {
        try {
            const guild = this.client.guilds.cache.get(config.discord.guildId);
            if (guild && this.logger) {
                await this.logger.updateMemberCount(guild.memberCount);
            }
        } catch (error) {
            console.error('❌ Failed to update member count:', error);
        }
    }

    // Create admin control panels
    async createAdminPanels() {
        try {
            const guild = this.client.guilds.cache.get(config.discord.guildId);
            if (!guild) {
                console.warn('❌ Guild not found');
                return;
            }

            // Create primary platform channel
            const primaryChannel = guild.channels.cache.get(config.discord.adminChannelId);
            if (primaryChannel) {
                const primaryEmbed = createPrimaryPlatformEmbed();
                await primaryChannel.send(primaryEmbed);
                console.log('✅ Primary platform created');
            }

            // Create engagement platform channel (if different)
            if (config.discord.engagementChannelId && config.discord.engagementChannelId !== config.discord.adminChannelId) {
                const engagementChannel = guild.channels.cache.get(config.discord.engagementChannelId);
                if (engagementChannel) {
                    const engagementEmbed = createEngagementPlatformEmbed();
                    await engagementChannel.send(engagementEmbed);
                    console.log('✅ Engagement platform created');
                }
            }

        } catch (error) {
            console.error('❌ Error creating admin panels:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Admin panel creation');
            }
        }
    }

    // Track new member
    async trackNewMember(member) {
        try {
            const isVerified = member.roles.cache.has(config.discord.verifiedRoleId);
            const hasClosedDms = member.roles.cache.has(config.discord.closedDmsRoleId);

            await db.trackMember(
                member.user.id,
                member.user.tag,
                isVerified,
                hasClosedDms
            );

            console.log(`👤 New member tracked: ${member.user.tag}`);

            // Log member activity
            if (this.logger) {
                await this.logger.logMemberActivity('Joined', member, {
                    reason: `New member joined the server`,
                    role: isVerified ? 'Verified' : 'Unverified'
                });
            }

            // Schedule auto-DM if eligible
            if (!hasClosedDms && config.features.autoDm.enabled) {
                this.scheduleAutoDM(member.user.id);
            }

            // Record analytics
            await db.recordEvent('member_join', 'organic');

            // Update member count for logging
            await this.updateMemberCountForLogging();

        } catch (error) {
            console.error('❌ Error tracking new member:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Member tracking');
            }
        }
    }

    // Mark member as left
    async markMemberAsLeft(userId) {
        try {
            await db.updateMemberStatus(userId, { still_in_server: false });
            console.log(`👋 Member marked as left: ${userId}`);

            // Log member activity
            if (this.logger) {
                await this.logger.logMemberActivity('Left', { user: { id: userId, tag: 'Unknown' } }, {
                    reason: 'Member left the server'
                });
            }

            // Update member count for logging
            await this.updateMemberCountForLogging();

        } catch (error) {
            console.error('❌ Error marking member as left:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Member leave tracking');
            }
        }
    }

    // Check role changes
    async checkRoleChanges(oldMember, newMember) {
        try {
            const userId = newMember.user.id;
            const hadClosedDms = oldMember.roles.cache.has(config.discord.closedDmsRoleId);
            const hasClosedDms = newMember.roles.cache.has(config.discord.closedDmsRoleId);
            const wasVerified = oldMember.roles.cache.has(config.discord.verifiedRoleId);
            const isVerified = newMember.roles.cache.has(config.discord.verifiedRoleId);

            // Update closed DMs status
            if (hadClosedDms !== hasClosedDms) {
                await db.updateMemberStatus(userId, { has_closed_dms_role: hasClosedDms });
                console.log(`🔒 Member ${userId} closed DMs role: ${hasClosedDms}`);

                // Log role change
                if (this.logger) {
                    await this.logger.logMemberActivity('Role Changed', newMember, {
                        role: hasClosedDms ? 'Closed DMs' : 'Open DMs'
                    });
                }
            }

            // Update verification status
            if (wasVerified !== isVerified) {
                await db.updateMemberStatus(userId, { is_verified: isVerified });
                console.log(`✅ Member ${userId} verification: ${isVerified}`);

                // Log verification change
                if (this.logger) {
                    await this.logger.logMemberActivity('Verification Changed', newMember, {
                        role: isVerified ? 'Verified' : 'Unverified'
                    });
                }
            }

        } catch (error) {
            console.error('❌ Error checking role changes:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Role change tracking');
            }
        }
    }

    // Schedule auto-DM
    scheduleAutoDM(userId) {
        const delayMs = config.features.autoDm.delayMinutes * 60 * 1000;
        
        setTimeout(async () => {
            await this.processAutoDM(userId);
        }, delayMs);

        console.log(`⏰ Auto-DM scheduled for user ${userId} in ${config.features.autoDm.delayMinutes} minutes`);
    }

    // Process auto-DM
    async processAutoDM(userId) {
        try {
            // Check if member is still eligible
            const member = await this.client.guilds.cache.get(config.discord.guildId)?.members.fetch(userId).catch(() => null);
            if (!member) {
                await this.markMemberAsLeft(userId);
                return;
            }

            // Check compliance requirements
            const memberData = await db.getMember(userId);
            if (!memberData || memberData.welcome_dm_sent || memberData.has_closed_dms_role) {
                return;
            }

            // Check if member is verified
            if (!member.roles.cache.has(config.discord.verifiedRoleId)) {
                console.log(`⏳ Member ${userId} not verified yet, skipping auto-DM`);
                return;
            }

            // Get active auto-DM template
            const template = await db.getActiveTemplate('auto_dm');
            if (!template) {
                console.warn('⚠️ No active auto-DM template found');
                return;
            }

            // Send auto-DM
            await member.send({
                embeds: [createEmbedFromTemplate(template)],
                components: [createOptOutButton()]
            });

            // Mark as sent
            await db.updateMemberStatus(userId, { 
                welcome_dm_sent: true, 
                dm_sent_at: new Date().toISOString() 
            });

            // Update template usage
            await db.updateTemplateUsage(template.id);

            // Record analytics
            await db.recordEvent('auto_dm_sent', 'auto_dm');

            // Log DM activity
            if (this.logger) {
                await this.logger.logDM(userId, member.user.tag, 'Sent', {
                    type: 'Auto-DM (Welcome)'
                });
            }

            console.log(`✅ Auto-DM sent to ${member.user.tag}`);

        } catch (error) {
            console.error(`❌ Failed to process auto-DM for user ${userId}:`, error);
            if (this.logger) {
                await this.logger.logError(error, 'Auto-DM processing');
            }
        }
    }

    // Start auto-DM processor
    startAutoDMProcessor() {
        setInterval(async () => {
            try {
                const eligibleMembers = await db.getMembersForAutoDM();
                
                for (const member of eligibleMembers.slice(0, config.features.autoDm.maxPerHour)) {
                    await this.processAutoDM(member.user_id);
                    // Small delay between DMs
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                console.error('❌ Auto-DM processor error:', error);
                if (this.logger) {
                    await this.logger.logError(error, 'Auto-DM processor');
                }
            }
        }, 60000); // Check every minute
    }

    // Handle button interactions
    async handleButtonInteraction(interaction) {
        try {
            const { customId } = interaction;

            // Check if user is server owner
            if (interaction.member.id !== config.discord.serverOwnerId) {
                await interaction.reply({ 
                    content: '❌ Only the server owner can use these controls.', 
                    ephemeral: true 
                });
                return;
            }

            switch (customId) {
                case 'health_check':
                    await this.handleHealthCheck(interaction);
                    break;
                case 'send_statistics':
                    await this.handleStatistics(interaction);
                    break;
                case 'init_database':
                    await this.handleDatabaseInit(interaction);
                    break;
                default:
                    await interaction.reply({ 
                        content: '⚠️ This feature is not implemented yet.', 
                        ephemeral: true 
                    });
            }

        } catch (error) {
            console.error('❌ Button interaction error:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Button interaction');
            }
            await interaction.reply({ 
                content: '❌ An error occurred while processing your request.', 
                ephemeral: true 
            });
        }
    }

    // Handle health check
    async handleHealthCheck(interaction) {
        try {
            const healthData = await this.getHealthStatus();
            const { createHealthCheckEmbed } = require('./discord/embeds');
            const embed = createHealthCheckEmbed(healthData);
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
            console.error('❌ Health check error:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Health check');
            }
            await interaction.reply({ 
                content: '❌ Failed to get health status.', 
                ephemeral: true 
            });
        }
    }

    // Handle statistics
    async handleStatistics(interaction) {
        try {
            const stats = await this.getStatistics();
            const { createStatisticsEmbed } = require('./discord/embeds');
            const embed = createStatisticsEmbed(stats);
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
            console.error('❌ Statistics error:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Statistics');
            }
            await interaction.reply({ 
                content: '❌ Failed to get statistics.', 
                ephemeral: true 
            });
        }
    }

    // Handle database initialization
    async handleDatabaseInit(interaction) {
        try {
            await interaction.reply({ 
                content: '🔄 Initializing database... This may take a few seconds.', 
                ephemeral: true 
            });

            // Import and run database initialization
            const { initializeDatabase } = require('./database/init');
            await initializeDatabase();

            // Update member count for logging
            await this.updateMemberCountForLogging();

            await interaction.editReply({ 
                content: '✅ Database initialized successfully! All tables created and ready.', 
                ephemeral: true 
            });

            // Log the successful initialization
            if (this.logger) {
                await this.logger.sendStatusUpdate('Database Initialized', 'All database tables created successfully', '#00ff00');
            }

        } catch (error) {
            console.error('❌ Database initialization error:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Database initialization');
            }
            await interaction.editReply({ 
                content: `❌ Database initialization failed: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Get health status
    async getHealthStatus() {
        try {
            const uptime = Math.floor((Date.now() - this.startTime) / 1000);
            const lastOrder = await db.get(`
                SELECT order_number, created_at 
                FROM orders 
                ORDER BY created_at DESC 
                LIMIT 1
            `);

            return {
                status: 'healthy',
                uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
                database: true,
                lastOrder: lastOrder ? `${lastOrder.order_number} (${lastOrder.created_at})` : 'None'
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                database: false
            };
        }
    }

    // Get statistics
    async getStatistics() {
        try {
            const today = new Date().toISOString().split('T')[0];
            const stats = await db.getDailyStats(today);
            
            const result = {
                orders: 0,
                dms_sent: 0,
                total_members: 0
            };

            stats.forEach(stat => {
                if (stat.metric_type === 'order') result.orders = stat.total_count;
                if (stat.metric_type === 'auto_dm_sent') result.dms_sent = stat.total_count;
            });

            // Get total members
            const memberCount = await db.get('SELECT COUNT(*) as count FROM member_tracking WHERE still_in_server = TRUE');
            result.total_members = memberCount.count;

            return result;
        } catch (error) {
            console.error('❌ Statistics error:', error);
            return { orders: 0, dms_sent: 0, total_members: 0 };
        }
    }

    // Start the bot
    async start() {
        try {
            // Login to Discord
            await this.client.login(config.discord.token);

            // Start Express server
            this.app.listen(config.server.port, () => {
                console.log(`🌐 Webhook server running on port ${config.server.port}`);
            });

        } catch (error) {
            console.error('❌ Failed to start bot:', error);
            process.exit(1);
        }
    }

    // Graceful shutdown
    async shutdown() {
        console.log('🔄 Shutting down gracefully...');
        
        if (this.logger) {
            this.logger.stop();
        }
        
        if (this.client) {
            this.client.destroy();
        }
        
        if (db) {
            db.close();
        }
        
        process.exit(0);
    }
}

// Create and start the bot
const bot = new ShopifyDiscordBot();

// Handle shutdown signals
process.on('SIGTERM', () => bot.shutdown());
process.on('SIGINT', () => bot.shutdown());

// Start the bot
bot.start().catch(console.error);

// Helper function for embed templates
function createEmbedFromTemplate(template) {
    const { EmbedBuilder } = require('discord.js');
    
    const embed = new EmbedBuilder()
        .setTitle(template.title)
        .setDescription(template.description)
        .setColor(parseInt(template.color.replace('#', ''), 16))
        .setTimestamp();

    if (template.image_url) embed.setImage({ url: template.image_url });
    if (template.thumbnail_url) embed.setThumbnail({ url: template.thumbnail_url });
    if (template.footer_text) embed.setFooter({ text: template.footer_text });

    return embed;
}

// Helper function for opt-out button
function createOptOutButton() {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('opt_out_marketing')
                .setLabel('Opt out of marketing DMs')
                .setEmoji('🚫')
                .setStyle(ButtonStyle.Secondary)
        );
}
