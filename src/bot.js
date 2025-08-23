const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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
            this.shopifyWebhooks = new ShopifyWebhooks(this.client, this.logger);
            console.log('✅ Shopify webhooks initialized');

            // Create admin panels
            await this.createAdminPanels();
            console.log('✅ Admin panels created');

            // Start auto-DM processor
            this.startAutoDMProcessor();
            console.log('✅ Auto-DM processor started');

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

            // Schedule auto-DM if eligible (DISABLED BY DEFAULT)
            if (!hasClosedDms && config.features.autoDm.enabled) {
                // Auto-DM scheduling is DISABLED by default for safety
                console.log(`⏰ Auto-DM scheduled for user ${member.user.id} but system is DISABLED by default`);
                // this.scheduleAutoDM(member.user.id); // COMMENTED OUT FOR SAFETY
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

            // Create welcome DM with new embed
            const { createWelcomeDMEmbed } = require('./discord/embeds');
            const welcomeEmbed = createWelcomeDMEmbed();

            // Send auto-DM
            await member.send({
                embeds: [welcomeEmbed],
                components: [createOptOutButton()]
            });

            // Mark as sent
            await db.updateMemberStatus(userId, { 
                welcome_dm_sent: true, 
                dm_sent_at: new Date().toISOString() 
            });

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

    // Handle toggle orders
    async handleToggleOrders(interaction) {
        try {
            // Get current setting
            const currentSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['orders_enabled']);
            const newValue = currentSetting ? (currentSetting.value === 'true' ? 'false' : 'true') : 'true';
            
            // Update setting
            await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['orders_enabled', newValue]);
            
            const status = newValue === 'true' ? '✅ ENABLED' : '❌ DISABLED';
            await interaction.reply({ 
                content: `🛍️ Order notifications: **${status}**`, 
                ephemeral: true 
            });

            // Log the change
            if (this.logger) {
                await this.logger.sendStatusUpdate('Orders Toggled', `Order notifications ${newValue === 'true' ? 'enabled' : 'disabled'}`, newValue === 'true' ? '#00ff00' : '#ff0000');
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
            const newValue = currentSetting ? (currentSetting.value === 'true' ? 'false' : 'true') : 'true';
            
            // Update setting
            await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['auto_dm_enabled', newValue]);
            
            const status = newValue === 'true' ? '✅ ENABLED' : '❌ DISABLED';
            await interaction.reply({ 
                content: `⏰ Auto-DM system: **${status}**`, 
                ephemeral: true 
            });

            // Log the change
            if (this.logger) {
                await this.logger.sendStatusUpdate('Auto-DM Toggled', `Auto-DM system ${newValue === 'true' ? 'enabled' : 'disabled'}`, newValue === 'true' ? '#00ff00' : '#ff0000');
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
            await interaction.reply({ 
                content: '📧 Sending test welcome DM...', 
                ephemeral: true 
            });

            // Create welcome DM with new embed
            const { createWelcomeDMEmbed, createOptOutButton } = require('./discord/embeds');
            const welcomeEmbed = createWelcomeDMEmbed();

            // Send test DM to the user who clicked
            await interaction.user.send({
                embeds: [welcomeEmbed],
                components: [createOptOutButton()]
            });

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
                        .setCustomId(`send_message_${Buffer.from(messageText).toString('base64').substring(0, 50)}`)
                        .setLabel('✅ Send Message')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('dont_send_message')
                        .setLabel('❌ Don\'t Send')
                        .setStyle(ButtonStyle.Danger)
                );

            // Store message for later sending
            interaction.pendingMessage = messageText;

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
            // Get pending message from interaction
            const messageText = interaction.pendingMessage;
            
            if (!messageText) {
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
            await notificationChannel.send(messageText);

            // Update the interaction to show success
            await interaction.update({
                content: '✅ **Message sent successfully to notification channel!**',
                embeds: [],
                components: []
            });

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

            // Clear pending message
            interaction.pendingMessage = null;

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
                        .setCustomId(`send_dm_${targetUserId}_${Buffer.from(messageText).toString('base64').substring(0, 50)}`)
                        .setLabel('✅ Send DM')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('dont_send_dm')
                        .setLabel('❌ Don\'t Send')
                        .setStyle(ButtonStyle.Danger)
                );

            // Store data for later sending
            interaction.pendingDM = {
                userId: targetUserId,
                username: targetUser.tag,
                message: messageText
            };

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
            // Get pending DM data from interaction
            const pendingDM = interaction.pendingDM;
            
            if (!pendingDM) {
                await interaction.reply({
                    content: '❌ No DM data to send. Please try again.',
                    ephemeral: true
                });
                return;
            }

            // Try to send the DM
            try {
                const targetUser = await this.client.users.fetch(pendingDM.userId);
                await targetUser.send(pendingDM.message);
                
                // Update the interaction to show success
                await interaction.update({
                    content: `✅ **DM sent successfully to ${pendingDM.username}!**`,
                    embeds: [],
                    components: []
                });

                // Log the DM sending
                if (this.logger) {
                    await this.logger.logDM(pendingDM.userId, pendingDM.username, 'Sent', {
                        type: 'Manual DM',
                        message: pendingDM.message.substring(0, 100) + (pendingDM.message.length > 100 ? '...' : '')
                    });
                }

                // Record analytics
                await db.recordEvent('dm_sent', 'manual');

                console.log(`✅ DM sent to ${pendingDM.username} (${pendingDM.userId})`);

            } catch (dmError) {
                if (dmError.code === 50007) {
                    // User has DMs disabled
                    await interaction.update({
                        content: `❌ **Failed to send DM to ${pendingDM.username}**\n\n**Reason:** User has DMs disabled for this server.`,
                        embeds: [],
                        components: []
                    });
                } else {
                    // Other error
                    await interaction.update({
                        content: `❌ **Failed to send DM to ${pendingDM.username}**\n\n**Error:** ${dmError.message}`,
                        embeds: [],
                        components: []
                    });
                }

                // Log the DM failure
                if (this.logger) {
                    await this.logger.logDM(pendingDM.userId, pendingDM.username, 'Failed', {
                        type: 'Manual DM',
                        error: dmError.message
                    });
                }

                console.error(`❌ Failed to send DM to ${pendingDM.username}:`, dmError);
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

            // Clear pending DM data
            interaction.pendingDM = null;

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
                // For channel sending, we'll need to implement channel selection
                await interaction.update({
                    content: '📺 **Channel Selection Coming Soon!**\n\nThis will let you choose which channel to send the template to.',
                    embeds: [],
                    components: []
                });
            } else if (destination === 'members') {
                // For member sending, we'll need to implement member selection
                await interaction.update({
                    content: '👥 **Member Selection Coming Soon!**\n\nThis will let you choose which members to send the template to.',
                    embeds: [],
                    components: []
                });
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
