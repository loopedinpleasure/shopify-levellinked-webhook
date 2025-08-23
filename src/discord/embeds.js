const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');

// Primary Platform for core bot management
function createPrimaryPlatformEmbed() {
    const embed = new EmbedBuilder()
        .setTitle('🎛️ Shopify Bot - Primary Control Panel')
        .setDescription('Core bot management and analytics')
        .setColor('#00ff00')
        .addFields(
            { 
                name: '📊 Current Status', 
                value: 'All systems operational', 
                inline: false 
            },
            { 
                name: '🛍️ Features', 
                value: '• Real Orders\n• Auto-DM System\n• Custom Messages\n• Analytics Export', 
                inline: false 
            }
        )
        .setTimestamp();

    const toggleButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('toggle_orders')
                .setLabel('Toggle Orders')
                .setEmoji('🛍️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('toggle_auto_dm')
                .setLabel('Toggle Auto-DM')
                .setEmoji('⏰')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('send_statistics')
                .setLabel('Analytics')
                .setEmoji('📊')
                .setStyle(ButtonStyle.Secondary)
        );

    const messageButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('custom_channel_message')
                .setLabel('📝 Channel Message')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('dm_single_user')
                .setLabel('👤 DM User')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('dm_all_members')
                .setLabel('📢 DM Everyone')
                .setStyle(ButtonStyle.Danger)
        );

    const managementButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_embed_template')
                .setLabel('🎨 Create Template')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('test_auto_dm')
                .setLabel('📧 Test Auto-DM')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('manage_categories')
                .setLabel('🏷️ Categories')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('export_ai_data')
                .setLabel('🤖 Export for AI')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('health_check')
                .setLabel('❤️ Health Check')
                .setStyle(ButtonStyle.Secondary)
        );

    return { embeds: [embed], components: [toggleButtons, messageButtons, managementButtons] };
}

// Engagement Platform for community features
function createEngagementPlatformEmbed() {
    const embed = new EmbedBuilder()
        .setTitle('🎉 Engagement Control Panel')
        .setDescription('Boost sales through community interaction')
        .setColor('#ffa500')
        .addFields(
            { 
                name: '🎯 Sales Features', 
                value: '• Product Polls\n• Referral Rewards\n• Shop Giveaways', 
                inline: false 
            },
            { 
                name: '📈 Growth Tools', 
                value: '• Invite Tracking\n• Engagement Analytics\n• Automated Rewards', 
                inline: false 
            }
        )
        .setTimestamp();

    const pollButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_product_poll')
                .setLabel('Create Poll')
                .setEmoji('📊')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('view_poll_results')
                .setLabel('Poll Results')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('close_active_polls')
                .setLabel('Close Polls')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Secondary)
        );

    const referralButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('view_referral_stats')
                .setLabel('Referral Stats')
                .setEmoji('👥')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('generate_reward_codes')
                .setLabel('Generate Rewards')
                .setEmoji('🎁')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('top_referrers')
                .setLabel('Top Referrers')
                .setEmoji('🏆')
                .setStyle(ButtonStyle.Secondary)
        );

    const giveawayButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_giveaway')
                .setLabel('Start Giveaway')
                .setEmoji('🎁')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('manage_giveaways')
                .setLabel('Manage Active')
                .setEmoji('⚙️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('giveaway_analytics')
                .setLabel('Giveaway Stats')
                .setEmoji('📊')
                .setStyle(ButtonStyle.Secondary)
        );

    return { embeds: [embed], components: [pollButtons, referralButtons, giveawayButtons] };
}

// Create embed from template
function createEmbedFromTemplate(template) {
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

// Create opt-out button
function createOptOutButton() {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('opt_out_marketing')
                .setLabel('Opt out of marketing DMs')
                .setEmoji('🚫')
                .setStyle(ButtonStyle.Secondary)
        );
}

// Create order notification embed with categorization
async function createOrderEmbed(orderData, product, category) {
    const embed = new EmbedBuilder()
        .setTitle(`🛍️ Someone ordered ${product.name}!`)
        .setDescription(`${category.emoji} **${category.name}**`)
        .setColor(getCategoryColor(category.name))
        .setTimestamp();

    // Add product image if available
    if (product.image_url) {
        embed.setThumbnail(product.image_url);
    }

    // Add product link
    if (product.product_id) {
        const shopUrl = config.shopify.shopUrl;
        embed.addFields({
            name: '🔗 View Product',
            value: `https://${shopUrl}/products/${product.product_id}`,
            inline: false
        });
    }

    // Add product details
    embed.addFields(
        {
            name: '📦 Product',
            value: product.name,
            inline: true
        },
        {
            name: '💰 Price',
            value: `$${parseFloat(product.price).toFixed(2)}`,
            inline: true
        }
    );

    // Add footer
    embed.setFooter({
        text: 'Level Linked • New Order'
    });

    return embed;
}

// Get category color
function getCategoryColor(categoryName) {
    const colors = {
        'Adult Toys': '#ff69b4',
        'Accessories': '#4169e1',
        'General': '#00ff00'
    };
    
    return colors[categoryName] || '#00ff00';
}

// Create statistics embed
function createStatisticsEmbed(stats) {
    const embed = new EmbedBuilder()
        .setTitle('📊 Bot Statistics')
        .setDescription('Current bot performance metrics')
        .setColor('#00ff00')
        .setTimestamp();

    if (stats.orders) {
        embed.addFields({
            name: '🛍️ Orders Today',
            value: stats.orders.toString(),
            inline: true
        });
    }

    if (stats.dms_sent) {
        embed.addFields({
            name: '📧 DMs Sent Today',
            value: stats.dms_sent.toString(),
            inline: true
        });
    }

    if (stats.total_members) {
        embed.addFields({
            name: '👥 Total Members',
            value: stats.total_members.toString(),
            inline: true
        });
    }

    return embed;
}

// Create health check embed
function createHealthCheckEmbed(healthData) {
    const embed = new EmbedBuilder()
        .setTitle('❤️ Bot Health Check')
        .setDescription('System status and performance')
        .setColor(healthData.status === 'healthy' ? '#00ff00' : '#ff0000')
        .setTimestamp();

    embed.addFields(
        {
            name: '🔄 Status',
            value: healthData.status === 'healthy' ? '✅ Healthy' : '❌ Issues Detected',
            inline: true
        },
        {
            name: '⏱️ Uptime',
            value: healthData.uptime || 'Unknown',
            inline: true
        },
        {
            name: '💾 Database',
            value: healthData.database ? '✅ Connected' : '❌ Disconnected',
            inline: true
        }
    );

    if (healthData.lastOrder) {
        embed.addFields({
            name: '📦 Last Order',
            value: healthData.lastOrder,
            inline: false
        });
    }

    return embed;
}

module.exports = {
    createPrimaryPlatformEmbed,
    createEngagementPlatformEmbed,
    createEmbedFromTemplate,
    createOptOutButton,
    createOrderEmbed,
    createStatisticsEmbed,
    createHealthCheckEmbed
};
