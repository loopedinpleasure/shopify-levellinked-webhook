const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
const express = require('express');
const config = require('./config');
const db = require('./database/db');
const ShopifyWebhooks = require('./shopify/webhooks');
const BotLogger = require('./utils/logger');
const MessageQueue = require('./queue/messageQueue');
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

        // Initialize message queue
        this.messageQueue = null;

        // Bot state
        this.isReady = false;
        this.startTime = Date.now();

        // Store pending data for button interactions
        this.pendingData = new Map();

        // Setup event handlers
        this.setupEventHandlers();
        this.setupExpressRoutes();

        // Start pending data cleanup (every hour)
        setInterval(() => this.cleanupPendingData(), 60 * 60 * 1000);

        console.log('🎉 Bot fully initialized and ready!');
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
            } else if (interaction.isModalSubmit()) {
                await this.handleModalSubmit(interaction);
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
            this.shopifyWebhooks = new ShopifyWebhooks(this.client, this.logger, this.messageQueue);
            console.log('✅ Shopify webhooks initialized');

            // Initialize message queue
            this.messageQueue = new MessageQueue(this.client, this.logger);
            console.log('✅ Message queue initialized');

            // Create admin panels
            await this.createAdminPanels();
            console.log('✅ Admin panels created');

            // Start auto-DM processor
            this.startAutoDMProcessor();
            console.log('✅ Auto-DM processor started');

            // Process any messages that were queued while bot was offline
            await this.messageQueue.processOfflineMessages();
            console.log('✅ Offline message processing completed');

            // Schedule daily and weekly summaries
            this.scheduleSummaries();
            console.log('✅ Summary scheduling started');

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
            console.log(`🔍 DEBUG: trackNewMember called for ${member.user.tag} (${member.user.id})`);
            
            const query = `
                INSERT OR REPLACE INTO member_tracking (
                    user_id, username, joined_at, is_verified, has_closed_dms_role, still_in_server
                ) VALUES (?, ?, datetime('now'), ?, ?, TRUE)
            `;
            
            const isVerified = member.roles.cache.has(process.env.VERIFIED_ROLE_ID);
            const hasClosedDms = member.roles.cache.has(process.env.CLOSED_DMS_ROLE_ID);
            
            console.log(`🔍 DEBUG: Member verification status:`, isVerified);
            console.log(`🔍 DEBUG: Member has closed DMs role:`, hasClosedDms);
            console.log(`🔍 DEBUG: Looking for verified role ID:`, process.env.VERIFIED_ROLE_ID);
            console.log(`🔍 DEBUG: Looking for closed DMs role ID:`, process.env.CLOSED_DMS_ROLE_ID);
            
            await this.db.run(query, [member.user.id, member.user.tag, isVerified, hasClosedDms]);
            console.log(`🔍 DEBUG: Member tracking data inserted for ${member.user.id}`);

            // Schedule auto-DM for 65 minutes later if not closed DMs
            if (!hasClosedDms) {
                console.log(`🔍 DEBUG: Scheduling auto-DM for ${member.user.id} (no closed DMs role)`);
                const delayMs = 65 * 60 * 1000; // 65 minutes
                this.scheduleAutoDM(member.user.id, delayMs);
                console.log(`🔍 DEBUG: Auto-DM scheduled for ${member.user.id} in ${delayMs}ms (${delayMs/1000/60} minutes)`);
            } else {
                console.log(`🔍 DEBUG: Skipping auto-DM for ${member.user.id} (has closed DMs role)`);
            }

            // Track for analytics
            if (this.analytics) {
                await this.analytics.recordEvent('member_join', 'organic');
                console.log(`🔍 DEBUG: Analytics recorded for member join: ${member.user.id}`);
            }
            
            console.log(`🔍 DEBUG: trackNewMember completed for ${member.user.id}`);
        } catch (error) {
            console.error(`🔍 DEBUG: Failed to track new member ${member.user.id}:`, error);
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
    scheduleAutoDM(userId, delayMs) {
        console.log(`🔍 DEBUG: scheduleAutoDM called for user ${userId} with delay ${delayMs}ms (${delayMs/1000/60} minutes)`);
        
        setTimeout(async () => {
            console.log(`🔍 DEBUG: Auto-DM timeout triggered for user ${userId}, calling processAutoDM`);
            await this.processAutoDM(userId);
        }, delayMs);

        console.log(`⏰ Auto-DM scheduled for user ${userId} in ${delayMs}ms (${delayMs/1000/60} minutes)`);
    }

    // Process auto-DM
    async processAutoDM(userId) {
        try {
            console.log(`🔍 DEBUG: processAutoDM called for user ${userId}`);
            
            // Verify member is still in server and verified
            const guild = this.client.guilds.cache.get(process.env.GUILD_ID);
            console.log(`🔍 DEBUG: Guild found:`, guild ? guild.name : 'NOT FOUND');
            
            const member = await guild.members.fetch(userId).catch((error) => {
                console.log(`🔍 DEBUG: Failed to fetch member ${userId}:`, error.message);
                return null;
            });
            
            if (!member) {
                console.log(`🔍 DEBUG: Member ${userId} not found in guild, marking as left`);
                await this.markMemberAsLeft(userId);
                return;
            }
            
            console.log(`🔍 DEBUG: Member found: ${member.user.tag} (${member.user.id})`);
            console.log(`🔍 DEBUG: Member roles:`, member.roles.cache.map(r => r.name).join(', '));

            // Check all compliance requirements
            const memberData = await this.db.get(
                'SELECT * FROM member_tracking WHERE user_id = ?',
                [userId]
            );
            
            console.log(`🔍 DEBUG: Member tracking data:`, memberData);
            
            if (!memberData) {
                console.log(`🔍 DEBUG: No member tracking data found for ${userId}`);
                return;
            }
            
            if (memberData.welcome_dm_sent) {
                console.log(`🔍 DEBUG: Welcome DM already sent for ${userId}`);
                return;
            }
            
            if (memberData.has_closed_dms_role) {
                console.log(`🔍 DEBUG: Member ${userId} has closed DMs role, skipping`);
                return;
            }

            // Check if member is verified
            const isVerified = member.roles.cache.has(process.env.VERIFIED_ROLE_ID);
            console.log(`🔍 DEBUG: Member verification status:`, isVerified);
            console.log(`🔍 DEBUG: Looking for verified role ID:`, process.env.VERIFIED_ROLE_ID);
            
            if (!isVerified) {
                console.log(`🔍 DEBUG: Member ${userId} not verified yet, skipping auto-DM`);
                return;
            }

            // Get active auto-DM template
            const template = await this.db.get(
                'SELECT * FROM embed_templates WHERE template_type = ? AND is_active = TRUE',
                ['auto_dm']
            );
            
            console.log(`🔍 DEBUG: Auto-DM template found:`, template);
            
            if (!template) {
                console.log(`🔍 DEBUG: No active auto-DM template found, creating default welcome embed`);
                
                // Clear module cache to ensure fresh import
                delete require.cache[require.resolve('./discord/embeds')];
                const { createWelcomeDMEmbed, createOptOutButton } = require('./discord/embeds');
                
                console.log(`🔍 DEBUG: About to create welcome embed for ${userId}`);
                const welcomeEmbed = createWelcomeDMEmbed();
                console.log(`🔍 DEBUG: Welcome embed created for ${userId}:`, {
                    title: welcomeEmbed.data.title,
                    description: welcomeEmbed.data.description,
                    color: welcomeEmbed.data.color
                });

                // Queue the welcome DM instead of sending directly
                console.log(`🔍 DEBUG: About to queue welcome DM for ${userId}`);
                
                if (this.messageQueue) {
                    await this.messageQueue.addMessage({
                        type: 'auto_dm',
                        target_type: 'user',
                        target_id: userId,
                        message_data: JSON.stringify({
                                                 welcome_message: `Welcome to **Looped!**
         Level up with our special offers!
         https://levellinked.myshopify.com/`,
                            components: [createOptOutButton()]
                        }),
                        priority: 1
                    });
                    
                    console.log(`🔍 DEBUG: Welcome DM queued for ${userId}`);
                } else {
                    console.warn('❌ Message queue not available, sending directly');
                                 // Fallback to direct sending
             const welcomeMessage = `Welcome to **Looped!**
             Level up with our special offers!
             https://levellinked.myshopify.com/`;
                    
                    await member.send(welcomeMessage);
                    
                    // Send the opt-out button separately
                    await member.send({
                        components: [createOptOutButton()]
                    });
                    
                    console.log(`🔍 DEBUG: Welcome DM sent directly to ${userId} (fallback)`);
                }

                // Mark as sent
                await this.db.run(
                    'UPDATE member_tracking SET welcome_dm_sent = TRUE, dm_sent_at = datetime("now") WHERE user_id = ?',
                    [userId]
                );
                
                console.log(`🔍 DEBUG: Member tracking updated for ${userId}`);
                
                // Record analytics
                if (this.analytics) {
                    await this.analytics.recordEvent('auto_dm_sent', 'auto_dm');
                }
                
                console.log(`🔍 DEBUG: Analytics recorded for ${userId}`);
            } else {
                console.log(`🔍 DEBUG: Using template-based auto-DM for ${userId}`);
                // Queue the auto-DM using template
                const { createEmbedFromTemplate, createOptOutButton } = require('./discord/embeds');
                await this.messageQueue.addMessage({
                    type: 'auto_dm',
                    target_type: 'user',
                    target_id: userId,
                    message_data: JSON.stringify({
                        embeds: [createEmbedFromTemplate(template)],
                        components: [createOptOutButton()]
                    }),
                    priority: 1
                });
                
                console.log(`🔍 DEBUG: Template-based auto-DM queued for ${userId}`);
            }

            console.log(`🔍 DEBUG: processAutoDM completed successfully for ${userId}`);
        } catch (error) {
            console.error(`🔍 DEBUG: Failed to process auto-DM for user ${userId}:`, error);
        }
    }

    // Schedule daily and weekly summaries
    scheduleSummaries() {
        // Daily summary at 2:00 AM
        const dailySchedule = '0 2 * * *';
        const weeklySchedule = '0 2 * * 1'; // Monday at 2:00 AM

        // Schedule daily summary
        setInterval(() => {
            const now = new Date();
            if (now.getHours() === 2 && now.getMinutes() === 0) {
                if (this.logger) {
                    this.logger.sendDailySummary();
                }
            }
        }, 60000); // Check every minute

        // Schedule weekly summary
        setInterval(() => {
            const now = new Date();
            if (now.getDay() === 1 && now.getHours() === 2 && now.getMinutes() === 0) {
                if (this.logger) {
                    this.logger.sendWeeklySummary();
                }
            }
        }, 60000); // Check every minute

        console.log('📅 Daily (2:00 AM) and weekly (Monday 2:00 AM) summaries scheduled');
    }

    // Start auto-DM processor (DISABLED BY DEFAULT)
    startAutoDMProcessor() {
        // Auto-DM processor is DISABLED by default for safety
        // Only runs when explicitly enabled via admin panel
        console.log('⚠️ Auto-DM processor is DISABLED by default for safety');
        console.log('📧 Use the "Toggle Auto-DM" button to enable when ready');
        
        // Check every 5 minutes if auto-DM is enabled
        setInterval(async () => {
            try {
                // Check if auto-DM is enabled in settings
                const setting = await db.get('SELECT value FROM settings WHERE key = ?', ['auto_dm_enabled']);
                const isEnabled = setting && setting.value === 'true';
                
                if (!isEnabled) {
                    return; // Skip if not enabled
                }
                
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
        }, 300000); // Check every 5 minutes instead of every minute
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
                case 'toggle_orders':
                    await this.handleToggleOrders(interaction);
                    break;
                case 'toggle_auto_dm':
                    await this.handleToggleAutoDM(interaction);
                    break;
                case 'health_check':
                    await this.handleHealthCheck(interaction);
                    break;
                case 'send_statistics':
                    await this.handleStatistics(interaction);
                    break;
                case 'init_database':
                    await this.handleDatabaseInit(interaction);
                    break;
                case 'test_auto_dm':
                    await this.handleTestAutoDM(interaction);
                    break;
                case 'test_message_queue':
                    await this.handleTestMessageQueue(interaction);
                    break;
                case 'create_embed_template':
                    await this.handleCreateTemplate(interaction);
                    break;
                case 'custom_channel_message':
                    await this.handleCustomChannelMessage(interaction);
                    break;
                case 'dm_single_user':
                    await this.handleDMSingleUser(interaction);
                    break;
                case 'export_ai_data':
                    await this.handleExportAIData(interaction);
                    break;
                case 'export_member_data':
                    await this.handleExportMemberData(interaction);
                    break;
                case 'export_order_data':
                    await this.handleExportOrderData(interaction);
                    break;
                case 'export_dm_data':
                    await this.handleExportDMData(interaction);
                    break;
                case 'export_all_data':
                    await this.handleExportAllData(interaction);
                    break;
                case 'generate_ai_prompts':
                    await this.handleGenerateAIPrompts(interaction);
                    break;
                case 'copy_member_prompt':
                    await this.handleCopyPrompt(interaction, 'member');
                    break;
                case 'copy_sales_prompt':
                    await this.handleCopyPrompt(interaction, 'sales');
                    break;
                case 'copy_dm_prompt':
                    await this.handleCopyPrompt(interaction, 'dm');
                    break;
                case 'copy_bi_prompt':
                    await this.handleCopyPrompt(interaction, 'bi');
                    break;
                case 'back_to_prompts':
                    await this.handleGenerateAIPrompts(interaction);
                    break;
                case 'template_library':
                    await this.handleTemplateLibrary(interaction);
                    break;
                case 'send_template':
                    await this.handleSendTemplate(interaction);
                    break;
                case 'send_to_channel':
                    await this.handleSendToChannel(interaction);
                    break;
                case 'dont_send_message':
                    await this.handleDontSendMessage(interaction);
                    break;
                case 'dont_send_dm':
                    await this.handleDontSendDM(interaction);
                    break;
                case 'send_to_members':
                    await this.handleSendToMembers(interaction);
                    break;
                case 'back_to_destination':
                    await this.handleSendTemplate(interaction);
                    break;
                case 'back_to_templates_channel':
                    await this.handleSendToChannel(interaction);
                    break;
                case 'back_to_templates_members':
                    await this.handleSendToMembers(interaction);
                    break;
                case 'change_template_channel':
                    await this.handleSendToChannel(interaction);
                    break;
                case 'change_template_members':
                    await this.handleSendToMembers(interaction);
                    break;
                case 'send_to_all_members':
                    await this.handleSendToAllMembers(interaction);
                    break;
                case 'send_to_verified':
                    await this.handleSendToVerified(interaction);
                    break;
                case 'send_to_role':
                    await this.handleSendToRole(interaction);
                    break;
                case 'cancel_send':
                    await this.handleCancelSend(interaction);
                    break;
                default:
                    if (customId.startsWith('select_template_')) {
                        await this.handleTemplateSelection(interaction, customId);
                    } else if (customId.startsWith('confirm_send_')) {
                        await this.handleConfirmSend(interaction, customId);
                    } else if (customId.startsWith('delete_template_')) {
                        await this.handleDeleteTemplate(interaction, customId);
                    } else if (customId.startsWith('send_message_')) {
                        await this.handleSendMessage(interaction, customId);
                    } else if (customId.startsWith('send_dm_')) {
                        await this.handleSendDM(interaction, customId);
                    } else if (customId.startsWith('select_channel_')) {
                        await this.handleChannelSelection(interaction, customId);
                    } else if (customId.startsWith('send_to_all_members_')) {
                        await this.handleSendToAllMembers(interaction, customId);
                    } else if (customId.startsWith('send_to_verified_')) {
                        await this.handleSendToVerified(interaction, customId);
                    } else if (customId.startsWith('send_to_role_')) {
                        await this.handleSendToRole(interaction, customId);
                    } else if (customId.startsWith('back_to_template_')) {
                        await this.handleBackToTemplate(interaction, customId);
                    } else if (customId.startsWith('send_template_to_channel_')) {
                        await this.handleSendTemplateToChannel(interaction, customId);
                    } else if (customId.startsWith('send_template_to_all_')) {
                        await this.handleSendTemplateToAll(interaction, customId);
                    } else if (customId.startsWith('send_template_to_verified_')) {
                        await this.handleSendTemplateToVerified(interaction, customId);
                    } else {
                        await interaction.reply({ 
                            content: '⚠️ This feature is not implemented yet.', 
                            ephemeral: true 
                        });
                    }
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
            
            // Add message queue status to health data
            if (this.messageQueue) {
                const queueStats = await this.messageQueue.getQueueStats();
                healthData.messageQueue = {
                    status: 'operational',
                    pending: queueStats.pending,
                    sent: queueStats.sent,
                    failed: queueStats.failed,
                    total: queueStats.total
                };
            } else {
                healthData.messageQueue = {
                    status: 'not_initialized',
                    pending: 0,
                    sent: 0,
                    failed: 0,
                    total: 0
                };
            }
            
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
            
            // Create action buttons for additional analytics
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('export_member_data')
                        .setLabel('📊 Export Member Data')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('export_order_data')
                        .setLabel('🛍️ Export Order Data')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('export_dm_data')
                        .setLabel('📧 Export DM Data')
                        .setStyle(ButtonStyle.Primary)
                );

            const exportButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('export_all_data')
                        .setLabel('📁 Export All Data')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('generate_ai_prompts')
                        .setLabel('🤖 Generate AI Prompts')
                        .setStyle(ButtonStyle.Secondary)
                );
            
            await interaction.reply({ 
                embeds: [embed], 
                components: [actionButtons, exportButtons],
                ephemeral: true 
            });
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

    // Handle toggle orders
    async handleToggleOrders(interaction) {
        try {
            // Get current setting
            const currentSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['orders_enabled']);
            
            // If setting doesn't exist, create it with default value 'true'
            if (!currentSetting) {
                await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['orders_enabled', 'true']);
                const newValue = 'false'; // Toggle to disabled
                await db.run('UPDATE settings SET value = ? WHERE key = ?', [newValue, 'orders_enabled']);
            } else {
                const newValue = currentSetting.value === 'true' ? 'false' : 'true';
                await db.run('UPDATE settings SET value = ? WHERE key = ?', [newValue, 'orders_enabled']);
            }
            
            // Get the final value to display
            const finalSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['orders_enabled']);
            const status = finalSetting.value === 'true' ? '✅ ENABLED' : '❌ DISABLED';
            
            await interaction.reply({ 
                content: `🛍️ Order notifications: **${status}**`, 
                ephemeral: true 
            });

            // Log the change
            if (this.logger) {
                await this.logger.sendStatusUpdate('Orders Toggled', `Order notifications ${finalSetting.value === 'true' ? 'enabled' : 'disabled'}`, finalSetting.value === 'true' ? '#00ff00' : '#ff0000');
            }

        } catch (error) {
            console.error('❌ Toggle orders error:', error);
            await interaction.reply({ 
                content: '❌ Failed to toggle orders.', 
                ephemeral: true 
            });
        }
    }

    // Handle toggle auto-DM
    async handleToggleAutoDM(interaction) {
        try {
            // Get current setting
            const currentSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['auto_dm_enabled']);
            
            // If setting doesn't exist, create it with default value 'false'
            if (!currentSetting) {
                await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['auto_dm_enabled', 'false']);
                const newValue = 'true'; // Toggle to enabled
                await db.run('UPDATE settings SET value = ? WHERE key = ?', [newValue, 'auto_dm_enabled']);
            } else {
                const newValue = currentSetting.value === 'true' ? 'false' : 'true';
                await db.run('UPDATE settings SET value = ? WHERE key = ?', [newValue, 'auto_dm_enabled']);
            }
            
            // Get the final value to display
            const finalSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['auto_dm_enabled']);
            const status = finalSetting.value === 'true' ? '✅ ENABLED' : '❌ DISABLED';
            
            await interaction.reply({ 
                content: `⏰ Auto-DM system: **${status}**`, 
                ephemeral: true 
            });

            // Log the change
            if (this.logger) {
                await this.logger.sendStatusUpdate('Auto-DM Toggled', `Auto-DM system ${finalSetting.value === 'true' ? 'enabled' : 'disabled'}`, finalSetting.value === 'true' ? '#00ff00' : '#ff0000');
            }

        } catch (error) {
            console.error('❌ Toggle auto-DM error:', error);
            await interaction.reply({ 
                content: '❌ Failed to toggle auto-DM.', 
                ephemeral: true 
            });
        }
    }

    // Handle custom channel message
    async handleCustomChannelMessage(interaction) {
        try {
            // Create the modal for message input
            const modal = new ModalBuilder()
                .setCustomId('custom_message_modal')
                .setTitle('📝 Send Message to Notification Channel');

            // Message text input
            const messageInput = new TextInputBuilder()
                .setCustomId('message_text')
                .setLabel('Message Text')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Type your message here...')
                .setRequired(true)
                .setMaxLength(2000);

            // Add input to modal
            const actionRow = new ActionRowBuilder().addComponents(messageInput);
            modal.addComponents(actionRow);

            // Show the modal
            await interaction.showModal(modal);

        } catch (error) {
            console.error('❌ Custom channel message modal error:', error);
            await interaction.reply({ 
                content: '❌ Failed to open message modal.', 
                ephemeral: true 
            });
        }
    }

    // Handle test auto-DM
    async handleTestAutoDM(interaction) {
        try {
            console.log('🔍 DEBUG: handleTestAutoDM called');
            await interaction.reply({ 
                content: '📧 Sending test welcome DM...', 
                ephemeral: true 
            });

            // Clear module cache to ensure fresh import
            console.log('🔍 DEBUG: Clearing module cache for embeds');
            delete require.cache[require.resolve('./discord/embeds')];
            
            // Create welcome DM with new embed
            console.log('🔍 DEBUG: About to import createWelcomeDMEmbed');
            const { createWelcomeDMEmbed, createOptOutButton, getWelcomeMessageText } = require('./discord/embeds');
            console.log('🔍 DEBUG: createWelcomeDMEmbed imported:', typeof createWelcomeDMEmbed);
            
            // Test the welcome message text first
            console.log('🔍 DEBUG: Testing welcome message text');
            const testMessage = getWelcomeMessageText();
            console.log('🔍 DEBUG: Test message text:', testMessage);
            
            console.log('🔍 DEBUG: Calling createWelcomeDMEmbed()');
            const welcomeEmbed = createWelcomeDMEmbed();
            console.log('🔍 DEBUG: Welcome embed created:', {
                title: welcomeEmbed.data.title,
                description: welcomeEmbed.data.description,
                color: welcomeEmbed.data.color
            });

            // Send test DM to the user who clicked
            console.log('🔍 DEBUG: About to send DM with simple text message');
            
                    // Send simple text message instead of embed
        const welcomeMessage = `Welcome to **Looped!**
        Level up with our special offers!
        https://levellinked.myshopify.com/`;
            
            // Send the welcome message
            await interaction.user.send(welcomeMessage);
            
            // Send the opt-out button separately
            await interaction.user.send({
                components: [createOptOutButton()]
            });

            console.log('🔍 DEBUG: DM sent successfully');
            await interaction.editReply({ 
                content: '✅ Test welcome DM sent successfully! Check your DMs.', 
                ephemeral: true 
            });

            // Log the test
            if (this.logger) {
                await this.logger.logDM(interaction.user.id, interaction.user.tag, 'Test Sent', {
                    type: 'Test Auto-DM (Welcome)'
                });
            }

        } catch (error) {
            console.error('❌ Test auto-DM error:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Test auto-DM');
            }
            await interaction.editReply({ 
                content: `❌ Failed to send test DM: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle test message queue
    async handleTestMessageQueue(interaction) {
        try {
            console.log('🔍 DEBUG: handleTestMessageQueue called');
            await interaction.reply({ 
                content: '📬 Testing message queue system...', 
                ephemeral: true 
            });

            if (!this.messageQueue) {
                await interaction.editReply({ 
                    content: '❌ Message queue not initialized', 
                    ephemeral: true 
                });
                return;
            }

            // Test queuing a message
            const testMessage = {
                type: 'custom_channel',
                target_type: 'channel',
                target_id: config.discord.notificationChannelId,
                message_data: JSON.stringify({
                    content: '🧪 **Test Message Queue**\n\nThis message was queued and processed through the message queue system. If you see this, the queue is working correctly!'
                }),
                priority: 1
            };

            const success = await this.messageQueue.addMessage(testMessage);
            
            if (success) {
                await interaction.editReply({ 
                    content: '✅ Test message queued successfully! Check the notification channel in a few seconds.', 
                    ephemeral: true 
                });
                
                // Log the test
                if (this.logger) {
                    await this.logger.logEvent('Message Queue Test', 'Test message queued successfully', '#00ff00');
                }
            } else {
                await interaction.editReply({ 
                    content: '❌ Failed to queue test message', 
                    ephemeral: true 
                });
            }

        } catch (error) {
            console.error('❌ Test message queue error:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Test Message Queue');
            }
            await interaction.editReply({ 
                content: `❌ Failed to test message queue: ${error.message}`, 
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

    // Handle DM single user
    async handleDMSingleUser(interaction) {
        try {
            // Create the modal for user selection and message input
            const modal = new ModalBuilder()
                .setCustomId('dm_single_user_modal')
                .setTitle('👤 Send DM to Single User');

            // User ID input
            const userIdInput = new TextInputBuilder()
                .setCustomId('target_user_id')
                .setLabel('User ID (Discord User ID)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g., 123456789012345678')
                .setRequired(true)
                .setMaxLength(20);

            // Message text input
            const messageInput = new TextInputBuilder()
                .setCustomId('dm_message_text')
                .setLabel('Message Text')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Type your message here...')
                .setRequired(true)
                .setMaxLength(2000);

            // Add inputs to modal
            const firstActionRow = new ActionRowBuilder().addComponents(userIdInput);
            const secondActionRow = new ActionRowBuilder().addComponents(messageInput);

            modal.addComponents(firstActionRow, secondActionRow);

            // Show the modal
            await interaction.showModal(modal);

        } catch (error) {
            console.error('❌ DM single user modal error:', error);
            await interaction.reply({ 
                content: '❌ Failed to open DM modal.', 
                ephemeral: true 
            });
        }
    }

    // Handle create embed template
    async handleCreateTemplate(interaction) {
        try {
            // Create the modal for template creation
            const modal = new ModalBuilder()
                .setCustomId('create_template_modal')
                .setTitle('🎨 Create Embed Template');

            // Template name input
            const nameInput = new TextInputBuilder()
                .setCustomId('template_name')
                .setLabel('Template Name (for your reference)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g., Welcome Message, Product Announcement')
                .setRequired(true)
                .setMaxLength(50);

            // Title input
            const titleInput = new TextInputBuilder()
                .setCustomId('template_title')
                .setLabel('Title (displayed at top)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g., Welcome to Level Linked!')
                .setRequired(true)
                .setMaxLength(256);

            // Description input
            const descriptionInput = new TextInputBuilder()
                .setCustomId('template_description')
                .setLabel('Description (main content + links)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('e.g., Thanks for joining! Check out our latest products: https://levellinked.myshopify.com')
                .setRequired(true)
                .setMaxLength(4000);

            // Image URL input (optional)
            const imageInput = new TextInputBuilder()
                .setCustomId('template_image')
                .setLabel('Image URL (optional)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://example.com/image.jpg')
                .setRequired(false)
                .setMaxLength(2000);

            // Footer input (optional)
            const footerInput = new TextInputBuilder()
                .setCustomId('template_footer')
                .setLabel('Footer Text (optional)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g., Level Linked - Premium Adult Toys')
                .setRequired(false)
                .setMaxLength(256);

            // Add inputs to modal
            const firstActionRow = new ActionRowBuilder().addComponents(nameInput);
            const secondActionRow = new ActionRowBuilder().addComponents(titleInput);
            const thirdActionRow = new ActionRowBuilder().addComponents(descriptionInput);
            const fourthActionRow = new ActionRowBuilder().addComponents(imageInput);
            const fifthActionRow = new ActionRowBuilder().addComponents(footerInput);

            modal.addComponents(firstActionRow, secondActionRow, thirdActionRow, fourthActionRow, fifthActionRow);

            // Show the modal
            await interaction.showModal(modal);

        } catch (error) {
            console.error('❌ Create template modal error:', error);
            await interaction.reply({ 
                content: '❌ Failed to open template creation modal.', 
                ephemeral: true 
            });
        }
    }

    // Handle export AI data
    async handleExportAIData(interaction) {
        try {
            await interaction.reply({ 
                content: '📊 Export AI data feature coming soon! This will let you export all AI-related data to a CSV file.', 
                ephemeral: true 
            });

            // TODO: Implement modal for data selection
            // TODO: Add file download

        } catch (error) {
            console.error('❌ Export AI data error:', error);
            await interaction.reply({ 
                content: '❌ Feature not ready yet.', 
                ephemeral: true 
            });
        }
    }

    // Handle export member data
    async handleExportMemberData(interaction) {
        try {
            await interaction.reply({ 
                content: '📊 Exporting member data... This may take a few seconds.', 
                ephemeral: true 
            });

            // Get all member data
            const members = await db.all(`
                SELECT 
                    user_id,
                    username,
                    joined_at,
                    is_verified,
                    has_closed_dms_role,
                    welcome_dm_sent,
                    dm_sent_at,
                    opt_out_at,
                    still_in_server,
                    total_invites,
                    referral_rewards_earned,
                    created_at
                FROM member_tracking 
                ORDER BY joined_at DESC
            `);

            if (members.length === 0) {
                await interaction.editReply({ 
                    content: '❌ No member data found to export.', 
                    ephemeral: true 
                });
                return;
            }

            // Create CSV content
            const csvHeaders = [
                'User ID',
                'Username',
                'Joined At',
                'Is Verified',
                'Has Closed DMs',
                'Welcome DM Sent',
                'DM Sent At',
                'Opt Out At',
                'Still In Server',
                'Total Invites',
                'Referral Rewards',
                'Created At'
            ];

            const csvRows = members.map(member => [
                member.user_id,
                member.username,
                member.joined_at,
                member.is_verified ? 'Yes' : 'No',
                member.has_closed_dms_role ? 'Yes' : 'No',
                member.welcome_dm_sent ? 'Yes' : 'No',
                member.dm_sent_at || '',
                member.opt_out_at || '',
                member.still_in_server ? 'Yes' : 'No',
                member.total_invites,
                member.referral_rewards_earned,
                member.created_at
            ]);

            const csvContent = [csvHeaders, ...csvRows]
                .map(row => row.map(field => `"${field}"`).join(','))
                .join('\n');

            // Create and send file
            const buffer = Buffer.from(csvContent, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: `member_data_${new Date().toISOString().split('T')[0]}.csv` });

            await interaction.editReply({ 
                content: `✅ **Member data exported successfully!**\n\n📊 **Total members:** ${members.length}\n📁 **File:** member_data_${new Date().toISOString().split('T')[0]}.csv\n\nUse this data with ChatGPT, Claude, or any AI tool for analysis!`,
                files: [attachment],
                ephemeral: true 
            });

            // Log the export
            if (this.logger) {
                await this.logger.sendStatusUpdate('Data Exported', `Member data exported (${members.length} records)`, '#00ff00');
            }

        } catch (error) {
            console.error('❌ Export member data error:', error);
            await interaction.editReply({ 
                content: `❌ Failed to export member data: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle export order data
    async handleExportOrderData(interaction) {
        try {
            await interaction.reply({ 
                content: '🛍️ Exporting order data... This may take a few seconds.', 
                ephemeral: true 
            });

            // Get all order data
            const orders = await db.all(`
                SELECT 
                    order_number,
                    customer_email,
                    total_price,
                    currency,
                    status,
                    created_at,
                    updated_at
                FROM orders 
                ORDER BY created_at DESC
            `);

            if (orders.length === 0) {
                await interaction.editReply({ 
                    content: '❌ No order data found to export.', 
                    ephemeral: true 
                });
                return;
            }

            // Create CSV content
            const csvHeaders = [
                'Order Number',
                'Customer Email',
                'Total Price',
                'Currency',
                'Status',
                'Created At',
                'Updated At'
            ];

            const csvRows = orders.map(order => [
                order.order_number,
                order.customer_email || '',
                order.total_price,
                order.currency,
                order.status,
                order.created_at,
                order.updated_at
            ]);

            const csvContent = [csvHeaders, ...csvRows]
                .map(row => row.map(field => `"${field}"`).join(','))
                .join('\n');

            // Create and send file
            const buffer = Buffer.from(csvContent, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: `order_data_${new Date().toISOString().split('T')[0]}.csv` });

            await interaction.editReply({ 
                content: `✅ **Order data exported successfully!**\n\n🛍️ **Total orders:** ${orders.length}\n📁 **File:** order_data_${new Date().toISOString().split('T')[0]}.csv\n\nUse this data with AI tools for sales analysis and insights!`,
                files: [attachment],
                ephemeral: true 
            });

            // Log the export
            if (this.logger) {
                await this.logger.sendStatusUpdate('Data Exported', `Order data exported (${orders.length} records)`, '#00ff00');
            }

        } catch (error) {
            console.error('❌ Export order data error:', error);
            await interaction.editReply({ 
                content: `❌ Failed to export order data: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle export DM data
    async handleExportDMData(interaction) {
        try {
            await interaction.reply({ 
                content: '📧 Exporting DM data... This may take a few seconds.', 
                ephemeral: true 
            });

            // Get all DM analytics data
            const dmData = await db.all(`
                SELECT 
                    metric_type,
                    source_type,
                    count,
                    metadata,
                    created_at
                FROM analytics 
                WHERE metric_type LIKE '%dm%'
                ORDER BY created_at DESC
            `);

            if (dmData.length === 0) {
                await interaction.editReply({ 
                    content: '❌ No DM data found to export.', 
                    ephemeral: true 
                });
                return;
            }

            // Create CSV content
            const csvHeaders = [
                'Metric Type',
                'Source Type',
                'Count',
                'Metadata',
                'Created At'
            ];

            const csvRows = dmData.map(record => [
                record.metric_type,
                record.source_type || '',
                record.count,
                record.metadata || '',
                record.created_at
            ]);

            const csvContent = [csvHeaders, ...csvRows]
                .map(row => row.map(field => `"${field}"`).join(','))
                .join('\n');

            // Create and send file
            const buffer = Buffer.from(csvContent, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: `dm_data_${new Date().toISOString().split('T')[0]}.csv` });

            await interaction.editReply({ 
                content: `✅ **DM data exported successfully!**\n\n📧 **Total DM records:** ${dmData.length}\n📁 **File:** dm_data_${new Date().toISOString().split('T')[0]}.csv\n\nUse this data to analyze DM effectiveness and engagement!`,
                files: [attachment],
                ephemeral: true 
            });

            // Log the export
            if (this.logger) {
                await this.logger.sendStatusUpdate('Data Exported', `DM data exported (${dmData.length} records)`, '#00ff00');
            }

        } catch (error) {
            console.error('❌ Export DM data error:', error);
            await interaction.editReply({ 
                content: `❌ Failed to export DM data: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle export all data
    async handleExportAllData(interaction) {
        try {
            await interaction.reply({ 
                content: '📁 Exporting all data... This may take a few minutes.', 
                ephemeral: true 
            });

            // Get all data types
            const [members, orders, dmData, templates, analytics] = await Promise.all([
                db.all('SELECT * FROM member_tracking ORDER BY joined_at DESC'),
                db.all('SELECT * FROM orders ORDER BY created_at DESC'),
                db.all('SELECT * FROM analytics ORDER BY created_at DESC'),
                db.all('SELECT * FROM embed_templates ORDER BY created_at DESC'),
                db.all('SELECT * FROM categories ORDER BY created_at DESC')
            ]);

            // Create comprehensive CSV
            const csvHeaders = [
                'Data Type',
                'Record ID',
                'Data JSON',
                'Created At'
            ];

            const allRecords = [
                ...members.map(m => ['member', m.id, JSON.stringify(m), m.created_at]),
                ...orders.map(o => ['order', o.id, JSON.stringify(o), o.created_at]),
                ...dmData.map(d => ['dm_analytics', d.id, JSON.stringify(d), d.created_at]),
                ...templates.map(t => ['template', t.id, JSON.stringify(t), t.created_at]),
                ...analytics.map(a => ['category', a.id, JSON.stringify(a), a.created_at])
            ];

            const csvContent = [csvHeaders, ...allRecords]
                .map(row => row.map(field => `"${field}"`).join(','))
                .join('\n');

            // Create and send file
            const buffer = Buffer.from(csvContent, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: `all_data_${new Date().toISOString().split('T')[0]}.csv` });

            const totalRecords = allRecords.length;
            await interaction.editReply({ 
                content: `✅ **All data exported successfully!**\n\n📁 **Total records:** ${totalRecords}\n📊 **Breakdown:**\n   • Members: ${members.length}\n   • Orders: ${orders.length}\n   • DM Analytics: ${dmData.length}\n   • Templates: ${templates.length}\n   • Categories: ${analytics.length}\n\n📁 **File:** all_data_${new Date().toISOString().split('T')[0]}.csv\n\nThis comprehensive export is perfect for AI analysis and business intelligence!`,
                files: [attachment],
                ephemeral: true 
            });

            // Log the export
            if (this.logger) {
                await this.logger.sendStatusUpdate('Data Exported', `All data exported (${totalRecords} records)`, '#00ff00');
            }

        } catch (error) {
            console.error('❌ Export all data error:', error);
            await interaction.editReply({ 
                content: `❌ Failed to export all data: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle generate AI prompts
    async handleGenerateAIPrompts(interaction) {
        try {
            await interaction.reply({ 
                content: '🤖 Generating AI analysis prompts... This may take a few seconds.', 
                ephemeral: true 
            });

            // Get basic stats for context
            const stats = await this.getStatistics();
            
            // Generate AI prompts for different analysis types
            const prompts = this.generateAIPrompts(stats);

            // Create embed with prompts
            const embed = new EmbedBuilder()
                .setTitle('🤖 AI Analysis Prompts')
                .setDescription('Use these prompts with ChatGPT, Claude, or any AI tool to analyze your exported data!')
                .setColor('#36393f')
                .setTimestamp();

            // Add prompt fields
            embed.addFields(
                {
                    name: '📊 **Member Growth Analysis**',
                    value: prompts.memberGrowth,
                    inline: false
                },
                {
                    name: '🛍️ **Sales Performance Analysis**',
                    value: prompts.salesAnalysis,
                    inline: false
                },
                {
                    name: '📧 **DM Effectiveness Analysis**',
                    value: prompts.dmAnalysis,
                    inline: false
                },
                {
                    name: '🎯 **Business Intelligence**',
                    value: prompts.businessIntelligence,
                    inline: false
                }
            );

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('copy_member_prompt')
                        .setLabel('📋 Copy Member Prompt')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('copy_sales_prompt')
                        .setLabel('📋 Copy Sales Prompt')
                        .setStyle(ButtonStyle.Primary)
                );

            const copyButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('copy_dm_prompt')
                        .setLabel('📋 Copy DM Prompt')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('copy_bi_prompt')
                        .setLabel('📋 Copy BI Prompt')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.editReply({ 
                content: '🤖 **AI Analysis Prompts Generated!**\n\nUse these prompts with your exported CSV data for powerful insights.',
                embeds: [embed],
                components: [actionButtons, copyButtons],
                ephemeral: true 
            });

        } catch (error) {
            console.error('❌ Generate AI prompts error:', error);
            await interaction.editReply({ 
                content: `❌ Failed to generate AI prompts: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Generate AI prompts based on statistics
    generateAIPrompts(stats) {
        const memberGrowth = `Analyze this Discord server member data and provide insights on:
1. Member growth trends and patterns
2. Verification rate analysis
3. Member retention and churn rates
4. Seasonal growth patterns
5. Recommendations for member acquisition

Context: Server has ${stats.total_members} total members, ${stats.verified_members} verified, ${stats.new_members_today} new today, ${stats.new_members_week} new this week.`;

        const salesAnalysis = `Analyze this Shopify order data and provide insights on:
1. Sales trends and patterns
2. Customer behavior analysis
3. Revenue growth analysis
4. Seasonal sales patterns
5. Customer lifetime value insights

Context: ${stats.total_orders} total orders, ${stats.orders_today} today, ${stats.orders_week} this week, ${stats.orders_month} this month.`;

        const dmAnalysis = `Analyze this Discord DM engagement data and provide insights on:
1. DM effectiveness and engagement rates
2. Best timing for DMs
3. Template performance analysis
4. Opt-out rate analysis
5. Recommendations for DM strategy

Context: ${stats.total_dms} total DMs sent, ${stats.dms_today} today, ${stats.dms_week} this week.`;

        const businessIntelligence = `Provide comprehensive business intelligence analysis of this Discord + Shopify data:
1. Cross-platform customer journey analysis
2. Marketing effectiveness (Discord → Shopify conversion)
3. Customer engagement patterns
4. Revenue attribution to Discord activities
5. Strategic recommendations for growth

Focus on actionable insights that can improve business performance.`;

        return {
            memberGrowth,
            salesAnalysis,
            dmAnalysis,
            businessIntelligence
        };
    }

    // Handle copy prompt
    async handleCopyPrompt(interaction, promptType) {
        try {
            // Get stats for context
            const stats = await this.getStatistics();
            const prompts = this.generateAIPrompts(stats);
            
            let promptText = '';
            let promptName = '';
            
            switch (promptType) {
                case 'member':
                    promptText = prompts.memberGrowth;
                    promptName = 'Member Growth Analysis';
                    break;
                case 'sales':
                    promptText = prompts.salesAnalysis;
                    promptName = 'Sales Performance Analysis';
                    break;
                case 'dm':
                    promptText = prompts.dmAnalysis;
                    promptName = 'DM Effectiveness Analysis';
                    break;
                case 'bi':
                    promptText = prompts.businessIntelligence;
                    promptName = 'Business Intelligence';
                    break;
                default:
                    promptText = 'Invalid prompt type';
                    promptName = 'Unknown';
            }

            // Create embed with the prompt
            const embed = new EmbedBuilder()
                .setTitle(`📋 ${promptName} Prompt`)
                .setDescription('**Copy this prompt and use it with your exported CSV data:**')
                .addFields({
                    name: '🤖 **AI Prompt**',
                    value: `\`\`\`${promptText}\`\`\``,
                    inline: false
                })
                .setColor('#36393f')
                .setTimestamp()
                .setFooter({ text: 'Paste this prompt into ChatGPT, Claude, or any AI tool' });

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_prompts')
                        .setLabel('⬅️ Back to All Prompts')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                content: `📋 **${promptName} Prompt Ready!**\n\nCopy the prompt below and use it with your exported data for powerful AI analysis.`,
                embeds: [embed],
                components: [actionButtons]
            });

        } catch (error) {
            console.error('❌ Copy prompt error:', error);
            await interaction.reply({
                content: `❌ Failed to copy prompt: ${error.message}`,
                ephemeral: true
            });
        }
    }

    // Handle modal submissions
    async handleModalSubmit(interaction) {
        try {
            const { customId } = interaction;

            switch (customId) {
                case 'create_template_modal':
                    await this.handleCreateTemplateSubmit(interaction);
                    break;
                case 'custom_message_modal':
                    await this.handleCustomMessageSubmit(interaction);
                    break;
                case 'dm_single_user_modal':
                    await this.handleDMSingleUserSubmit(interaction);
                    break;
                default:
                    await interaction.reply({ 
                        content: '⚠️ Unknown modal submission.', 
                        ephemeral: true 
                    });
            }

        } catch (error) {
            console.error('❌ Modal submission error:', error);
            await interaction.reply({ 
                content: '❌ An error occurred while processing your submission.', 
                ephemeral: true 
            });
        }
    }

    // Handle create template modal submission
    async handleCreateTemplateSubmit(interaction) {
        try {
            // Extract form data
            const templateName = interaction.fields.getTextInputValue('template_name');
            const templateTitle = interaction.fields.getTextInputValue('template_title');
            const templateDescription = interaction.fields.getTextInputValue('template_description');
            const templateImage = interaction.fields.getTextInputValue('template_image') || null;
            const templateFooter = interaction.fields.getTextInputValue('template_footer') || null;

            // Save template to database
            await db.run(`
                INSERT INTO embed_templates 
                (name, template_type, title, description, image_url, footer_text, color, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            `, [
                templateName,
                'custom', // template type
                templateTitle,
                templateDescription,
                templateImage,
                templateFooter,
                '#36393f', // Discord gray color
                true // is_active
            ]);

            // Create preview embed
            const previewEmbed = new EmbedBuilder()
                .setTitle(templateTitle)
                .setDescription(templateDescription)
                .setColor('#36393f') // Discord gray
                .setTimestamp();

            if (templateImage) {
                previewEmbed.setImage({ url: templateImage });
            }

            if (templateFooter) {
                previewEmbed.setFooter({ text: templateFooter });
            }

            // Send confirmation with preview
            await interaction.reply({
                content: `✅ Template **"${templateName}"** created successfully!`,
                embeds: [previewEmbed],
                ephemeral: true
            });

            // Log the template creation
            if (this.logger) {
                await this.logger.sendStatusUpdate('Template Created', `New template "${templateName}" saved`, '#00ff00');
            }

        } catch (error) {
            console.error('❌ Template creation error:', error);
            await interaction.reply({ 
                content: `❌ Failed to create template: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle custom message modal submission
    async handleCustomMessageSubmit(interaction) {
        try {
            // Extract message text
            const messageText = interaction.fields.getTextInputValue('message_text');
            
            // Generate unique ID for this message
            const messageId = Date.now().toString();
            
            // Store message data for later sending
            this.pendingData.set(messageId, {
                type: 'channel_message',
                message: messageText
            });
            
            // Create preview embed in control panel
            const previewEmbed = new EmbedBuilder()
                .setTitle('📝 Message Preview')
                .setDescription('**Your message will be sent to the notification channel:**')
                .addFields({
                    name: '📄 Message Content',
                    value: messageText,
                    inline: false
                })
                .setColor('#36393f')
                .setTimestamp();

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`send_message_${messageId}`)
                        .setLabel('✅ Send Message')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('dont_send_message')
                        .setLabel('❌ Don\'t Send')
                        .setStyle(ButtonStyle.Danger)
                );

            // Send preview with buttons
            await interaction.reply({
                embeds: [previewEmbed],
                components: [actionButtons],
                ephemeral: true
            });

        } catch (error) {
            console.error('❌ Custom message submission error:', error);
            await interaction.reply({ 
                content: `❌ Failed to process message: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle send message button
    async handleSendMessage(interaction, customId) {
        try {
            // Extract message ID from custom ID
            const messageId = customId.replace('send_message_', '');
            
            // Get pending message data from storage
            const pendingData = this.pendingData.get(messageId);
            
            if (!pendingData || pendingData.type !== 'channel_message') {
                await interaction.reply({
                    content: '❌ No message to send. Please try again.',
                    ephemeral: true
                });
                return;
            }

            // Get notification channel from config
            const notificationChannel = this.client.channels.cache.get(config.discord.notificationChannelId);
            
            if (!notificationChannel) {
                await interaction.reply({
                    content: '❌ Notification channel not found. Please check your configuration.',
                    ephemeral: true
                });
                return;
            }

            // Send the message to notification channel
            await notificationChannel.send(pendingData.message);

            // Update the interaction to show success
            await interaction.update({
                content: '✅ **Message sent successfully to notification channel!**',
                embeds: [],
                components: []
            });

            // Clean up pending data
            this.pendingData.delete(messageId);

            // Log the message sending
            if (this.logger) {
                await this.logger.sendStatusUpdate('Message Sent', `Custom message sent to notification channel`, '#00ff00');
            }

        } catch (error) {
            console.error('❌ Send message error:', error);
            await interaction.reply({
                content: `❌ Failed to send message: ${error.message}`,
                ephemeral: true
            });
        }
    }

    // Handle don't send message button
    async handleDontSendMessage(interaction) {
        try {
            // Update the interaction to show cancellation
            await interaction.update({
                content: '❌ **Message cancelled. Nothing was sent.**',
                embeds: [],
                components: []
            });

            // Note: We can't clean up pending data here since we don't have the messageId
            // The data will be cleaned up when the send button is pressed or will expire naturally

        } catch (error) {
            console.error('❌ Don\'t send message error:', error);
            await interaction.reply({
                content: '❌ Failed to cancel message.',
                ephemeral: true
            });
        }
    }

    // Handle DM single user modal submission
    async handleDMSingleUserSubmit(interaction) {
        try {
            // Extract form data
            const targetUserId = interaction.fields.getTextInputValue('target_user_id');
            const messageText = interaction.fields.getTextInputValue('dm_message_text');
            
            // Validate user ID format
            if (!/^\d{17,20}$/.test(targetUserId)) {
                await interaction.reply({
                    content: '❌ Invalid User ID format. Please enter a valid Discord User ID (17-20 digits).',
                    ephemeral: true
                });
                return;
            }

            // Try to fetch the user
            let targetUser;
            try {
                targetUser = await this.client.users.fetch(targetUserId);
            } catch (error) {
                await interaction.reply({
                    content: '❌ User not found. Please check the User ID and try again.',
                    ephemeral: true
                });
                return;
            }

            // Check if user is in the server
            const guild = this.client.guilds.cache.get(config.discord.guildId);
            const member = await guild.members.fetch(targetUserId).catch(() => null);
            
            if (!member) {
                await interaction.reply({
                    content: '❌ User is not a member of this server.',
                    ephemeral: true
                });
                return;
            }

            // Check if user has closed DMs role
            if (member.roles.cache.has(config.discord.closedDmsRoleId)) {
                await interaction.reply({
                    content: '❌ Cannot send DM to this user - they have closed DMs enabled.',
                    ephemeral: true
                });
                return;
            }

            // Generate unique ID for this DM
            const dmId = Date.now().toString();
            
            // Store DM data for later sending
            this.pendingData.set(dmId, {
                type: 'single_dm',
                userId: targetUserId,
                username: targetUser.tag,
                message: messageText
            });

            // Create preview embed
            const previewEmbed = new EmbedBuilder()
                .setTitle('👤 DM Preview')
                .setDescription('**Your message will be sent to this user:**')
                .addFields(
                    {
                        name: '👤 Target User',
                        value: `${targetUser.tag} (${targetUserId})`,
                        inline: true
                    },
                    {
                        name: '📄 Message Content',
                        value: messageText,
                        inline: false
                    }
                )
                .setColor('#36393f')
                .setTimestamp();

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`send_dm_${dmId}`)
                        .setLabel('✅ Send DM')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('dont_send_dm')
                        .setLabel('❌ Don\'t Send')
                        .setStyle(ButtonStyle.Danger)
                );

            // Send preview with buttons
            await interaction.reply({
                embeds: [previewEmbed],
                components: [actionButtons],
                ephemeral: true
            });

        } catch (error) {
            console.error('❌ DM single user submission error:', error);
            await interaction.reply({ 
                content: `❌ Failed to process DM request: ${error.message}`, 
                ephemeral: true 
            });
        }
    }

    // Handle send DM button
    async handleSendDM(interaction, customId) {
        try {
            // Extract DM ID from custom ID
            const dmId = customId.replace('send_dm_', '');
            
            // Get pending DM data from storage
            const pendingData = this.pendingData.get(dmId);
            
            if (!pendingData || pendingData.type !== 'single_dm') {
                await interaction.reply({
                    content: '❌ No DM data to send. Please try again.',
                    ephemeral: true
                });
                return;
            }

            // Try to send the DM
            try {
                const targetUser = await this.client.users.fetch(pendingData.userId);
                await targetUser.send(pendingData.message);
                
                // Update the interaction to show success
                await interaction.update({
                    content: `✅ **DM sent successfully to ${pendingData.username}!**`,
                    embeds: [],
                    components: []
                });

                // Clean up pending data
                this.pendingData.delete(dmId);

                // Log the DM sending
                if (this.logger) {
                    await this.logger.logDM(pendingData.userId, pendingData.username, 'Sent', {
                        type: 'Manual DM',
                        message: pendingData.message.substring(0, 100) + (pendingData.message.length > 100 ? '...' : '')
                    });
                }

                // Record analytics
                await db.recordEvent('dm_sent', 'manual');

                console.log(`✅ DM sent to ${pendingData.username} (${pendingData.userId})`);

            } catch (dmError) {
                if (dmError.code === 50007) {
                    // User has DMs disabled
                    await interaction.update({
                        content: `❌ **Failed to send DM to ${pendingData.username}**\n\n**Reason:** User has DMs disabled for this server.`,
                        embeds: [],
                        components: []
                    });
                } else {
                    // Other error
                    await interaction.update({
                        content: `❌ **Failed to send DM to ${pendingData.username}**\n\n**Error:** ${dmError.message}`,
                        embeds: [],
                        components: []
                    });
                }

                // Clean up pending data even on failure
                this.pendingData.delete(dmId);

                // Log the DM failure
                if (this.logger) {
                    await this.logger.logDM(pendingData.userId, pendingData.username, 'Failed', {
                        type: 'Manual DM',
                        error: dmError.message
                    });
                }

                console.error(`❌ Failed to send DM to ${pendingData.username}:`, dmError);
            }

        } catch (error) {
            console.error('❌ Send DM error:', error);
            await interaction.reply({
                content: `❌ Failed to send DM: ${error.message}`,
                ephemeral: true
            });
        }
    }

    // Handle don't send DM button
    async handleDontSendDM(interaction) {
        try {
            // Update the interaction to show cancellation
            await interaction.update({
                content: '❌ **DM cancelled. Nothing was sent.**',
                embeds: [],
                components: []
            });

            // Note: We can't clean up pending data here since we don't have the dmId
            // The data will be cleaned up when the send button is pressed or will expire naturally

        } catch (error) {
            console.error('❌ Don\'t send DM error:', error);
            await interaction.reply({
                content: '❌ Failed to cancel DM.',
                ephemeral: true
            });
        }
    }

    // Handle template library
    async handleTemplateLibrary(interaction) {
        try {
            // Get all templates from database
            const templates = await db.all('SELECT * FROM embed_templates ORDER BY created_at DESC');
            
            if (templates.length === 0) {
                await interaction.reply({
                    content: '📚 No templates found. Create your first template using the 🎨 Create Template button!',
                    ephemeral: true
                });
                return;
            }

            // Create template list embed
            const embed = new EmbedBuilder()
                .setTitle('📚 Template Library')
                .setDescription(`You have **${templates.length}** saved templates`)
                .setColor('#36393f')
                .setTimestamp();

            // Add template list
            const templateList = templates.map((template, index) => {
                const createdDate = new Date(template.created_at).toLocaleDateString();
                return `${index + 1}. **${template.name}** (${createdDate})\n   └ ${template.title}`;
            }).join('\n\n');

            embed.addFields({
                name: '📋 Available Templates',
                value: templateList,
                inline: false
            });

            await interaction.reply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('❌ Template library error:', error);
            await interaction.reply({
                content: '❌ Failed to load template library.',
                ephemeral: true
            });
        }
    }

    // Handle send template
    async handleSendTemplate(interaction) {
        try {
            // Get all templates from database
            const templates = await db.all('SELECT * FROM embed_templates ORDER BY created_at DESC');
            
            if (templates.length === 0) {
                await interaction.reply({
                    content: '❌ No templates found. Create a template first using the 🎨 Create Template button!',
                    ephemeral: true
                });
                return;
            }

            // Create destination picker embed
            const embed = new EmbedBuilder()
                .setTitle('📤 Send Template - Step 1: Choose Destination')
                .setDescription('Where would you like to send this template?')
                .setColor('#36393f')
                .addFields(
                    { name: '📺 Channel', value: 'Send to a specific Discord channel', inline: true },
                    { name: '👥 Members', value: 'Send to specific server members', inline: true }
                )
                .setTimestamp();

            // Create destination buttons
            const destinationButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('send_to_channel')
                        .setLabel('📺 Send to Channel')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('send_to_members')
                        .setLabel('👥 Send to Members')
                        .setStyle(ButtonStyle.Primary)
                );

            // Store templates in interaction for next step
            interaction.templates = templates;

            await interaction.reply({
                embeds: [embed],
                components: [destinationButtons],
                ephemeral: true
            });

        } catch (error) {
            console.error('❌ Send template error:', error);
            await interaction.reply({
                content: '❌ Failed to load templates.',
                ephemeral: true
            });
        }
    }

    // Handle send to channel destination
    async handleSendToChannel(interaction) {
        try {
            // Get templates from previous step
            const templates = interaction.templates || [];
            
            if (templates.length === 0) {
                await interaction.reply({
                    content: '❌ No templates available. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Create template selection embed
            const embed = new EmbedBuilder()
                .setTitle('📤 Send Template - Step 2: Select Template')
                .setDescription('Choose which template to send:')
                .setColor('#36393f')
                .setTimestamp();

            // Add template list
            const templateList = templates.map((template, index) => {
                const createdDate = new Date(template.created_at).toLocaleDateString();
                return `${index + 1}. **${template.name}** (${createdDate})\n   └ ${template.title}`;
            }).join('\n\n');

            embed.addFields({
                name: '📋 Available Templates',
                value: templateList,
                inline: false
            });

            // Create template selection buttons (max 5 per row)
            const templateButtons = [];
            for (let i = 0; i < templates.length; i += 5) {
                const row = new ActionRowBuilder();
                const rowTemplates = templates.slice(i, i + 5);
                
                rowTemplates.forEach((template, index) => {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`select_template_${template.id}`)
                            .setLabel(`${i + index + 1}`)
                            .setStyle(ButtonStyle.Secondary)
                    );
                });
                
                templateButtons.push(row);
            }

            // Store templates and add back button
            interaction.templates = templates;
            interaction.destination = 'channel';

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_destination')
                        .setLabel('⬅️ Back to Destination')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                embeds: [embed],
                components: [...templateButtons, backButton]
            });

        } catch (error) {
            console.error('❌ Send to channel error:', error);
            await interaction.reply({
                content: '❌ Failed to load templates.',
                ephemeral: true
            });
        }
    }

    // Handle send to members destination
    async handleSendToMembers(interaction) {
        try {
            // Get templates from previous step
            const templates = interaction.templates || [];
            
            if (templates.length === 0) {
                await interaction.reply({
                    content: '❌ No templates available. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Create template selection embed
            const embed = new EmbedBuilder()
                .setTitle('📤 Send Template - Step 2: Select Template')
                .setDescription('Choose which template to send to members:')
                .setColor('#36393f')
                .setTimestamp();

            // Add template list
            const templateList = templates.map((template, index) => {
                const createdDate = new Date(template.created_at).toLocaleDateString();
                return `${index + 1}. **${template.name}** (${createdDate})\n   └ ${template.title}`;
            }).join('\n\n');

            embed.addFields({
                name: '📋 Available Templates',
                value: templateList,
                inline: false
            });

            // Create template selection buttons (max 5 per row)
            const templateButtons = [];
            for (let i = 0; i < templates.length; i += 5) {
                const row = new ActionRowBuilder();
                const rowTemplates = templates.slice(i, i + 5);
                
                rowTemplates.forEach((template, index) => {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`select_template_${template.id}`)
                            .setLabel(`${i + index + 1}`)
                            .setStyle(ButtonStyle.Secondary)
                    );
                });
                
                templateButtons.push(row);
            }

            // Store templates and add back button
            interaction.templates = templates;
            interaction.destination = 'members';

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_destination')
                        .setLabel('⬅️ Back to Destination')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                embeds: [embed],
                components: [...templateButtons, backButton]
            });

        } catch (error) {
            console.error('❌ Send to members error:', error);
            await interaction.reply({
                content: '❌ Failed to load templates.',
                ephemeral: true
            });
        }
    }

    // Handle template selection
    async handleTemplateSelection(interaction, customId) {
        try {
            // Extract template ID from custom ID
            const templateId = parseInt(customId.replace('select_template_', ''));
            
            // Get templates and destination from previous step
            const templates = interaction.templates || [];
            const destination = interaction.destination;
            
            if (templates.length === 0) {
                await interaction.reply({
                    content: '❌ No templates available. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Find the selected template
            const selectedTemplate = templates.find(t => t.id === templateId);
            if (!selectedTemplate) {
                await interaction.reply({
                    content: '❌ Template not found. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Create preview embed
            const previewEmbed = new EmbedBuilder()
                .setTitle(selectedTemplate.title)
                .setDescription(selectedTemplate.description)
                .setColor('#36393f')
                .setTimestamp();

            if (selectedTemplate.image_url) {
                previewEmbed.setImage({ url: selectedTemplate.image_url });
            }

            if (selectedTemplate.footer_text) {
                previewEmbed.setFooter({ text: selectedTemplate.footer_text });
            }

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`confirm_send_${templateId}_${destination}`)
                        .setLabel('✅ Send Now')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`change_template_${destination}`)
                        .setLabel('🔄 Change Template')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`delete_template_${templateId}`)
                        .setLabel('🗑️ Delete Template')
                        .setStyle(ButtonStyle.Danger)
                );

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`back_to_templates_${destination}`)
                        .setLabel('⬅️ Back to Templates')
                        .setStyle(ButtonStyle.Secondary)
                );

            // Store selected template for next step
            interaction.selectedTemplate = selectedTemplate;

            await interaction.update({
                content: `📤 **Preview of "${selectedTemplate.name}"**\n\n**Destination:** ${destination === 'channel' ? '📺 Channel' : '👥 Members'}`,
                embeds: [previewEmbed],
                components: [actionButtons, backButton]
            });

        } catch (error) {
            console.error('❌ Template selection error:', error);
            await interaction.reply({
                content: '❌ Failed to select template.',
                ephemeral: true
            });
        }
    }

    // Handle confirm send
    async handleConfirmSend(interaction, customId) {
        try {
            // Extract template ID and destination from custom ID
            const parts = customId.replace('confirm_send_', '').split('_');
            const templateId = parseInt(parts[0]);
            const destination = parts[1];
            
            // Get selected template from previous step
            const selectedTemplate = interaction.selectedTemplate;
            
            if (!selectedTemplate) {
                await interaction.reply({
                    content: '❌ No template selected. Please start over.',
                    ephemeral: true
                });
                return;
            }

            if (destination === 'channel') {
                // Show channel selection
                await this.showChannelSelection(interaction, selectedTemplate);
            } else if (destination === 'members') {
                // Show member selection
                await this.showMemberSelection(interaction, selectedTemplate);
            }

            // Log the template usage
            if (this.logger) {
                await this.logger.sendStatusUpdate('Template Send Attempted', `Template "${selectedTemplate.name}" prepared for ${destination}`, '#00ff00');
            }

        } catch (error) {
            console.error('❌ Confirm send error:', error);
            await interaction.reply({
                content: '❌ Failed to confirm send.',
                ephemeral: true
            });
        }
    }

    // Show channel selection for template sending
    async showChannelSelection(interaction, selectedTemplate) {
        try {
            // Get all text channels in the server
            const guild = this.client.guilds.cache.get(config.discord.guildId);
            const textChannels = guild.channels.cache.filter(channel => 
                channel.type === 0 && // Text channel
                channel.permissionsFor(this.client.user.id).has('SendMessages')
            );

            if (textChannels.size === 0) {
                await interaction.update({
                    content: '❌ **No accessible text channels found.**\n\nMake sure the bot has permission to send messages in channels.',
                    embeds: [],
                    components: []
                });
                return;
            }

            // Create channel selection embed
            const embed = new EmbedBuilder()
                .setTitle('📺 Channel Selection - Step 3')
                .setDescription(`**Template:** ${selectedTemplate.name}\n**Destination:** 📺 Channel\n\nChoose which channel to send the template to:`)
                .setColor('#36393f')
                .setTimestamp();

            // Create channel selection buttons (max 5 per row)
            const channelButtons = [];
            const channels = Array.from(textChannels.values());
            
            for (let i = 0; i < channels.length; i += 5) {
                const row = new ActionRowBuilder();
                const rowChannels = channels.slice(i, i + 5);
                
                rowChannels.forEach((channel, index) => {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`select_channel_${channel.id}_${selectedTemplate.id}`)
                            .setLabel(`#${channel.name}`)
                            .setStyle(ButtonStyle.Primary)
                    );
                });
                
                channelButtons.push(row);
            }

            // Add back button
            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`back_to_template_${selectedTemplate.id}_channel`)
                        .setLabel('⬅️ Back to Template')
                        .setStyle(ButtonStyle.Secondary)
                );

            // Store template for next step
            interaction.selectedTemplate = selectedTemplate;
            interaction.destination = 'channel';

            await interaction.update({
                content: `📺 **Select Channel for "${selectedTemplate.name}"**`,
                embeds: [embed],
                components: [...channelButtons, backButton]
            });

        } catch (error) {
            console.error('❌ Channel selection error:', error);
            await interaction.update({
                content: `❌ Failed to show channel selection: ${error.message}`,
                embeds: [],
                components: []
            });
        }
    }

    // Show member selection for template sending
    async showMemberSelection(interaction, selectedTemplate) {
        try {
            // Get all members in the server (excluding bots)
            const guild = this.client.guilds.cache.get(config.discord.guildId);
            const members = guild.members.cache.filter(member => 
                !member.user.bot && 
                !member.roles.cache.has(config.discord.closedDmsRoleId) // Skip users with closed DMs
            );

            if (members.size === 0) {
                await interaction.update({
                    content: '❌ **No eligible members found.**\n\nAll members either have closed DMs or are bots.',
                    embeds: [],
                    components: []
                });
                return;
            }

            // Create member selection embed
            const embed = new EmbedBuilder()
                .setTitle('👥 Member Selection - Step 3')
                .setDescription(`**Template:** ${selectedTemplate.name}\n**Destination:** 👥 Members\n\nChoose how to select members:`)
                .addFields(
                    { name: '📊 Total Eligible Members', value: `${members.size} members`, inline: true },
                    { name: '⚠️ Note', value: 'Users with closed DMs are automatically excluded', inline: true }
                )
                .setColor('#36393f')
                .setTimestamp();

            // Create member selection options
            const memberOptions = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`send_to_all_members_${selectedTemplate.id}`)
                        .setLabel('📢 Send to All Members')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`send_to_verified_${selectedTemplate.id}`)
                        .setLabel('✅ Send to Verified Only')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`send_to_role_${selectedTemplate.id}`)
                        .setLabel('🎭 Send to Role')
                        .setStyle(ButtonStyle.Secondary)
                );

            // Add back button
            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`back_to_template_${selectedTemplate.id}_members`)
                        .setLabel('⬅️ Back to Template')
                        .setStyle(ButtonStyle.Secondary)
                );

            // Store template for next step
            interaction.selectedTemplate = selectedTemplate;
            interaction.destination = 'members';

            await interaction.update({
                content: `👥 **Select Members for "${selectedTemplate.name}"**`,
                embeds: [embed],
                components: [memberOptions, backButton]
            });

        } catch (error) {
            console.error('❌ Member selection error:', error);
            await interaction.update({
                content: `❌ Failed to show member selection: ${error.message}`,
                embeds: [],
                components: []
            });
        }
    }

    // Handle channel selection
    async handleChannelSelection(interaction, customId) {
        try {
            // Extract channel ID and template ID
            const parts = customId.replace('select_channel_', '').split('_');
            const channelId = parts[0];
            const templateId = parseInt(parts[1]);
            
            // Get the selected template
            const selectedTemplate = interaction.selectedTemplate;
            if (!selectedTemplate) {
                await interaction.reply({
                    content: '❌ No template selected. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Get the channel
            const channel = this.client.channels.cache.get(channelId);
            if (!channel) {
                await interaction.reply({
                    content: '❌ Channel not found. Please try again.',
                    ephemeral: true
                });
                return;
            }

            // Create final confirmation embed
            const confirmEmbed = new EmbedBuilder()
                .setTitle('📺 Final Confirmation - Channel')
                .setDescription(`**Template:** ${selectedTemplate.name}\n**Channel:** #${channel.name}\n\n**Preview:**`)
                .setColor('#36393f')
                .setTimestamp();

            // Create the actual template embed
            const templateEmbed = new EmbedBuilder()
                .setTitle(selectedTemplate.title)
                .setDescription(selectedTemplate.description)
                .setColor('#36393f')
                .setTimestamp();

            if (selectedTemplate.image_url) {
                templateEmbed.setImage({ url: selectedTemplate.image_url });
            }

            if (selectedTemplate.footer_text) {
                templateEmbed.setFooter({ text: selectedTemplate.footer_text });
            }

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`send_template_to_channel_${channelId}_${templateId}`)
                        .setLabel('✅ Send to Channel')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`cancel_send_${templateId}`)
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            // Store final data
            interaction.finalChannel = channel;
            interaction.finalTemplate = selectedTemplate;

            await interaction.update({
                content: `📺 **Ready to send "${selectedTemplate.name}" to #${channel.name}**`,
                embeds: [confirmEmbed, templateEmbed],
                components: [actionButtons]
            });

        } catch (error) {
            console.error('❌ Channel selection error:', error);
            await interaction.reply({
                content: `❌ Failed to process channel selection: ${error.message}`,
                ephemeral: true
            });
        }
    }

    // Handle send to all members
    async handleSendToAllMembers(interaction, customId) {
        try {
            // Extract template ID
            const templateId = parseInt(customId.replace('send_to_all_members_', ''));
            
            // Get the selected template
            const selectedTemplate = interaction.selectedTemplate;
            if (!selectedTemplate) {
                await interaction.reply({
                    content: '❌ No template selected. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Get all eligible members
            const guild = this.client.guilds.cache.get(config.discord.guildId);
            const eligibleMembers = guild.members.cache.filter(member => 
                !member.user.bot && 
                !member.roles.cache.has(config.discord.closedDmsRoleId)
            );

            // Create final confirmation embed
            const confirmEmbed = new EmbedBuilder()
                .setTitle('👥 Final Confirmation - All Members')
                .setDescription(`**Template:** ${selectedTemplate.name}\n**Target:** All eligible members (${eligibleMembers.size})\n\n**Preview:**`)
                .setColor('#36393f')
                .setTimestamp();

            // Create the actual template embed
            const templateEmbed = new EmbedBuilder()
                .setTitle(selectedTemplate.title)
                .setDescription(selectedTemplate.description)
                .setColor('#36393f')
                .setTimestamp();

            if (selectedTemplate.image_url) {
                templateEmbed.setImage({ url: selectedTemplate.image_url });
            }

            if (selectedTemplate.footer_text) {
                templateEmbed.setFooter({ text: selectedTemplate.footer_text });
            }

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`send_template_to_all_${templateId}`)
                        .setLabel('✅ Send to All Members')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`cancel_send_${templateId}`)
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            // Store final data
            interaction.finalMembers = Array.from(eligibleMembers.values());
            interaction.finalTemplate = selectedTemplate;

            await interaction.update({
                content: `👥 **Ready to send "${selectedTemplate.name}" to ${eligibleMembers.size} members**`,
                embeds: [confirmEmbed, templateEmbed],
                components: [actionButtons]
            });

        } catch (error) {
            console.error('❌ Send to all members error:', error);
            await interaction.reply({
                content: `❌ Failed to process member selection: ${error.message}`,
                ephemeral: true
            });
        }
    }

    // Handle send to verified members only
    async handleSendToVerified(interaction, customId) {
        try {
            // Extract template ID
            const templateId = parseInt(customId.replace('send_to_verified_', ''));
            
            // Get the selected template
            const selectedTemplate = interaction.selectedTemplate;
            if (!selectedTemplate) {
                await interaction.reply({
                    content: '❌ No template selected. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Get verified members only
            const guild = this.client.guilds.cache.get(config.discord.guildId);
            const verifiedMembers = guild.members.cache.filter(member => 
                !member.user.bot && 
                !member.roles.cache.has(config.discord.closedDmsRoleId) &&
                member.roles.cache.has(config.discord.verifiedRoleId)
            );

            // Create final confirmation embed
            const confirmEmbed = new EmbedBuilder()
                .setTitle('✅ Final Confirmation - Verified Members')
                .setDescription(`**Template:** ${selectedTemplate.name}\n**Target:** Verified members only (${verifiedMembers.size})\n\n**Preview:**`)
                .setColor('#36393f')
                .setTimestamp();

            // Create the actual template embed
            const templateEmbed = new EmbedBuilder()
                .setTitle(selectedTemplate.title)
                .setDescription(selectedTemplate.description)
                .setColor('#36393f')
                .setTimestamp();

            if (selectedTemplate.image_url) {
                templateEmbed.setImage({ url: selectedTemplate.image_url });
            }

            if (selectedTemplate.footer_text) {
                templateEmbed.setFooter({ text: selectedTemplate.footer_text });
            }

            // Create action buttons
            const actionButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`send_template_to_verified_${templateId}`)
                        .setLabel('✅ Send to Verified')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`cancel_send_${templateId}`)
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            // Store final data
            interaction.finalMembers = Array.from(verifiedMembers.values());
            interaction.finalTemplate = selectedTemplate;

            await interaction.update({
                content: `✅ **Ready to send "${selectedTemplate.name}" to ${verifiedMembers.size} verified members**`,
                embeds: [confirmEmbed, templateEmbed],
                components: [actionButtons]
            });

        } catch (error) {
            console.error('❌ Send to verified error:', error);
            await interaction.reply({
                content: `❌ Failed to process verified selection: ${error.message}`,
                ephemeral: true
            });
        }
    }

    // Handle send to role (placeholder for now)
    async handleSendToRole(interaction, customId) {
        try {
            await interaction.update({
                content: '🎭 **Role-based sending coming soon!**\n\nThis will let you select specific roles to send templates to.',
                embeds: [],
                components: []
            });
        } catch (error) {
            console.error('❌ Send to role error:', error);
            await interaction.reply({
                content: '❌ Failed to process role selection.',
                ephemeral: true
            });
        }
    }

    // Handle back to template
    async handleBackToTemplate(interaction, customId) {
        try {
            // Extract template ID and destination
            const parts = customId.replace('back_to_template_', '').split('_');
            const templateId = parseInt(parts[0]);
            const destination = parts[1];
            
            // Get the selected template
            const selectedTemplate = interaction.selectedTemplate;
            if (!selectedTemplate) {
                await interaction.reply({
                    content: '❌ No template selected. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Go back to template selection
            if (destination === 'channel') {
                await this.handleSendToChannel(interaction);
            } else if (destination === 'members') {
                await this.handleSendToMembers(interaction);
            } else {
                await this.handleSendTemplate(interaction);
            }

        } catch (error) {
            console.error('❌ Back to template error:', error);
            await interaction.reply({
                content: '❌ Failed to go back.',
                ephemeral: true
            });
        }
    }

    // Handle send template to channel
    async handleSendTemplateToChannel(interaction, customId) {
        try {
            // Extract channel ID and template ID
            const parts = customId.replace('send_template_to_channel_', '').split('_');
            const channelId = parts[0];
            const templateId = parseInt(parts[1]);
            
            // Get the final data
            const channel = interaction.finalChannel;
            const template = interaction.finalTemplate;
            
            if (!channel || !template) {
                await interaction.reply({
                    content: '❌ Missing template or channel data. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Create the template embed
            const templateEmbed = new EmbedBuilder()
                .setTitle(template.title)
                .setDescription(template.description)
                .setColor('#36393f')
                .setTimestamp();

            if (template.image_url) {
                templateEmbed.setImage({ url: template.image_url });
            }

            if (template.footer_text) {
                templateEmbed.setFooter({ text: template.footer_text });
            }

            // Send to the channel
            await channel.send({ embeds: [templateEmbed] });

            // Update usage count
            await db.run('UPDATE embed_templates SET usage_count = usage_count + 1 WHERE id = ?', [templateId]);

            // Update the interaction
            await interaction.update({
                content: `✅ **Template "${template.name}" sent successfully to #${channel.name}!**`,
                embeds: [],
                components: []
            });

            // Log the action
            if (this.logger) {
                await this.logger.sendStatusUpdate('Template Sent', `Template "${template.name}" sent to #${channel.name}`, '#00ff00');
            }

            // Record analytics
            await db.recordEvent('template_sent', 'channel');

            console.log(`✅ Template "${template.name}" sent to #${channel.name}`);

        } catch (error) {
            console.error('❌ Send template to channel error:', error);
            await interaction.reply({
                content: `❌ Failed to send template: ${error.message}`,
                ephemeral: true
            });
        }
    }

    // Handle send template to all members
    async handleSendTemplateToAll(interaction, customId) {
        try {
            // Extract template ID
            const templateId = parseInt(customId.replace('send_template_to_all_', ''));
            
            // Get the final data
            const members = interaction.finalMembers;
            const template = interaction.finalTemplate;
            
            if (!members || !template) {
                await interaction.reply({
                    content: '❌ Missing template or member data. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Update the interaction to show progress
            await interaction.update({
                content: `📤 **Sending template "${template.name}" to ${members.length} members...**\n\nThis may take a few minutes.`,
                embeds: [],
                components: []
            });

            // Send to all members (with rate limiting)
            let successCount = 0;
            let failCount = 0;
            
            for (let i = 0; i < members.length; i++) {
                try {
                    const member = members[i];
                    
                    // Create the template embed
                    const templateEmbed = new EmbedBuilder()
                        .setTitle(template.title)
                        .setDescription(template.description)
                        .setColor('#36393f')
                        .setTimestamp();

                    if (template.image_url) {
                        templateEmbed.setImage({ url: template.image_url });
                    }

                    if (template.footer_text) {
                        templateEmbed.setFooter({ text: template.footer_text });
                    }

                    // Send DM
                    await member.send({ embeds: [templateEmbed] });
                    successCount++;
                    
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                } catch (error) {
                    failCount++;
                    console.error(`Failed to send to ${member.user.tag}:`, error);
                }
            }

            // Update usage count
            await db.run('UPDATE embed_templates SET usage_count = usage_count + 1 WHERE id = ?', [templateId]);

            // Final update
            await interaction.editReply({
                content: `✅ **Template "${template.name}" sent to members!**\n\n**Results:**\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`,
                embeds: [],
                components: []
            });

            // Log the action
            if (this.logger) {
                await this.logger.sendStatusUpdate('Template Sent', `Template "${template.name}" sent to ${successCount} members`, '#00ff00');
            }

            // Record analytics
            await db.recordEvent('template_sent', 'all_members');

            console.log(`✅ Template "${template.name}" sent to ${successCount} members`);

        } catch (error) {
            console.error('❌ Send template to all members error:', error);
            await interaction.editReply({
                content: `❌ Failed to send template: ${error.message}`,
                embeds: [],
                components: []
            });
        }
    }

    // Handle send template to verified members
    async handleSendTemplateToVerified(interaction, customId) {
        try {
            // Extract template ID
            const templateId = parseInt(customId.replace('send_template_to_verified_', ''));
            
            // Get the final data
            const members = interaction.finalMembers;
            const template = interaction.finalTemplate;
            
            if (!members || !template) {
                await interaction.reply({
                    content: '❌ Missing template or member data. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Update the interaction to show progress
            await interaction.update({
                content: `📤 **Sending template "${template.name}" to ${members.length} verified members...**\n\nThis may take a few minutes.`,
                embeds: [],
                components: []
            });

            // Send to verified members (with rate limiting)
            let successCount = 0;
            let failCount = 0;
            
            for (let i = 0; i < members.length; i++) {
                try {
                    const member = members[i];
                    
                    // Create the template embed
                    const templateEmbed = new EmbedBuilder()
                        .setTitle(template.title)
                        .setDescription(template.description)
                        .setColor('#36393f')
                        .setTimestamp();

                    if (template.image_url) {
                        templateEmbed.setImage({ url: template.image_url });
                    }

                    if (template.footer_text) {
                        templateEmbed.setFooter({ text: template.footer_text });
                    }

                    // Send DM
                    await member.send({ embeds: [templateEmbed] });
                    successCount++;
                    
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                } catch (error) {
                    failCount++;
                    console.error(`Failed to send to ${member.user.tag}:`, error);
                }
            }

            // Update usage count
            await db.run('UPDATE embed_templates SET usage_count = usage_count + 1 WHERE id = ?', [templateId]);

            // Final update
            await interaction.editReply({
                content: `✅ **Template "${template.name}" sent to verified members!**\n\n**Results:**\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`,
                embeds: [],
                components: []
            });

            // Log the action
            if (this.logger) {
                await this.logger.sendStatusUpdate('Template Sent', `Template "${template.name}" sent to ${successCount} verified members`, '#00ff00');
            }

            // Record analytics
            await db.recordEvent('template_sent', 'verified_members');

            console.log(`✅ Template "${template.name}" sent to ${successCount} verified members`);

        } catch (error) {
            console.error('❌ Send template to verified members error:', error);
            await interaction.editReply({
                content: `❌ Failed to send template: ${error.message}`,
                embeds: [],
                components: []
            });
        }
    }

    // Handle cancel send
    async handleCancelSend(interaction) {
        try {
            await interaction.update({
                content: '❌ **Template sending cancelled. Nothing was sent.**',
                embeds: [],
                components: []
            });

            // Clear final data
            interaction.finalChannel = null;
            interaction.finalMembers = null;
            interaction.finalTemplate = null;

        } catch (error) {
            console.error('❌ Cancel send error:', error);
            await interaction.reply({
                content: '❌ Failed to cancel.',
                ephemeral: true
            });
        }
    }

    // Handle delete template
    async handleDeleteTemplate(interaction, customId) {
        try {
            // Extract template ID from custom ID
            const templateId = parseInt(customId.replace('delete_template_', ''));
            
            // Get selected template from previous step
            const selectedTemplate = interaction.selectedTemplate;
            
            if (!selectedTemplate) {
                await interaction.reply({
                    content: '❌ No template selected. Please start over.',
                    ephemeral: true
                });
                return;
            }

            // Delete template from database
            await db.run('DELETE FROM embed_templates WHERE id = ?', [templateId]);

            // Log the deletion
            if (this.logger) {
                await this.logger.sendStatusUpdate('Template Deleted', `Template "${selectedTemplate.name}" removed`, '#ff0000');
            }

            await interaction.update({
                content: `🗑️ **Template "${selectedTemplate.name}" deleted successfully!**\n\nReturn to the main menu to create new templates or send existing ones.`,
                embeds: [],
                components: []
            });

        } catch (error) {
            console.error('❌ Delete template error:', error);
            await interaction.reply({
                content: '❌ Failed to delete template.',
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

    // Get comprehensive statistics
    async getStatistics() {
        try {
            const today = new Date().toISOString().split('T')[0];
            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const thisWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const thisMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            // Get today's stats
            const todayStats = await db.getDailyStats(today);
            const yesterdayStats = await db.getDailyStats(yesterday);
            
            // Get member counts
            const totalMembers = await db.get('SELECT COUNT(*) as count FROM member_tracking WHERE still_in_server = TRUE');
            const verifiedMembers = await db.get('SELECT COUNT(*) as count FROM member_tracking WHERE still_in_server = TRUE AND is_verified = TRUE');
            const newMembersToday = await db.get('SELECT COUNT(*) as count FROM member_tracking WHERE DATE(joined_at) = ?', [today]);
            const newMembersWeek = await db.get('SELECT COUNT(*) as count FROM member_tracking WHERE DATE(joined_at) >= ?', [thisWeek]);
            
            // Get order stats
            const totalOrders = await db.get('SELECT COUNT(*) as count FROM orders');
            const ordersToday = await db.get('SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = ?', [today]);
            const ordersWeek = await db.get('SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) >= ?', [thisWeek]);
            const ordersMonth = await db.get('SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) >= ?', [thisMonth]);
            
            // Get DM stats
            const totalDMs = await db.get('SELECT COUNT(*) as count FROM analytics WHERE metric_type = "dm_sent"');
            const dmsToday = await db.get('SELECT COUNT(*) as count FROM analytics WHERE metric_type = "dm_sent" AND DATE(created_at) = ?', [today]);
            const dmsWeek = await db.get('SELECT COUNT(*) as count FROM analytics WHERE metric_type = "dm_sent" AND DATE(created_at) >= ?', [thisWeek]);
            
            // Get template usage
            const totalTemplates = await db.get('SELECT COUNT(*) as count FROM embed_templates');
            const activeTemplates = await db.get('SELECT COUNT(*) as count FROM embed_templates WHERE is_active = TRUE');
            const totalTemplateSends = await db.get('SELECT SUM(usage_count) as total FROM embed_templates');
            
            // Calculate growth rates
            const memberGrowthRate = yesterdayStats.length > 0 ? 
                ((newMembersToday.count - (yesterdayStats.find(s => s.metric_type === 'member_join')?.total_count || 0)) / Math.max(1, yesterdayStats.find(s => s.metric_type === 'member_join')?.total_count || 1) * 100).toFixed(1) : '0.0';
            
            const orderGrowthRate = yesterdayStats.length > 0 ? 
                ((ordersToday.count - (yesterdayStats.find(s => s.metric_type === 'order')?.total_count || 0)) / Math.max(1, yesterdayStats.find(s => s.metric_type === 'order')?.total_count || 1) * 100).toFixed(1) : '0.0';

            return {
                // Member Statistics
                total_members: totalMembers.count,
                verified_members: verifiedMembers.count,
                new_members_today: newMembersToday.count,
                new_members_week: newMembersWeek.count,
                member_growth_rate: memberGrowthRate,
                
                // Order Statistics
                total_orders: totalOrders.count,
                orders_today: ordersToday.count,
                orders_week: ordersWeek.count,
                orders_month: ordersMonth.count,
                order_growth_rate: orderGrowthRate,
                
                // DM Statistics
                total_dms: totalDMs.count,
                dms_today: dmsToday.count,
                dms_week: dmsWeek.count,
                
                // Template Statistics
                total_templates: totalTemplates.count,
                active_templates: activeTemplates.count,
                total_template_sends: totalTemplateSends.total || 0,
                
                // Time Periods
                periods: { today, yesterday, thisWeek, thisMonth }
            };
        } catch (error) {
            console.error('❌ Statistics error:', error);
            return { 
                total_members: 0, 
                verified_members: 0,
                total_orders: 0,
                total_dms: 0,
                total_templates: 0,
                error: error.message 
            };
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

    // Cleanup pending data
    async cleanupPendingData() {
        try {
            const now = Date.now();
            const oneHourAgo = now - (60 * 60 * 1000); // 1 hour ago
            
            let cleanedCount = 0;
            
            // Clean up old pending data (older than 1 hour)
            for (const [id, data] of this.pendingData.entries()) {
                // Extract timestamp from ID (we use Date.now() for IDs)
                const timestamp = parseInt(id);
                if (timestamp < oneHourAgo) {
                    this.pendingData.delete(id);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`🧹 Cleaned up ${cleanedCount} old pending data entries`);
            }
            
            // Log current pending data count
            console.log(`📊 Current pending data entries: ${this.pendingData.size}`);
            
        } catch (error) {
            console.error('❌ Pending data cleanup error:', error);
        }
    }
}

// Create and start the bot
const bot = new ShopifyDiscordBot();

// Handle shutdown signals
process.on('SIGTERM', () => bot.shutdown());
process.on('SIGINT', () => bot.shutdown());

// Start the bot
bot.start().catch(console.error);


