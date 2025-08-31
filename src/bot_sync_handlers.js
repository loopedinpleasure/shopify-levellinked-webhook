// Offline Order Sync Handlers for Shopify Discord Bot

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Handle sync offline orders button
async function handleSyncOfflineOrders(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        console.log('🔄 User requested offline order sync');
        
        // Check if offline sync is available
        if (!this.offlineSync) {
            await interaction.editReply({
                content: '❌ Offline sync service not initialized. Please try again.',
                ephemeral: true
            });
            return;
        }

        // Start sync process
        const syncResult = await this.offlineSync.syncOfflineOrders(24); // Last 24 hours
        
        if (!syncResult.success) {
            await interaction.editReply({
                content: '❌ Failed to sync orders. Please check the logs.',
                ephemeral: true
            });
            return;
        }

        if (syncResult.ordersToProcess === 0) {
            await interaction.editReply({
                content: `✅ No new orders found in the last 24 hours.\n\n📊 Sync Results:\n• Orders found: ${syncResult.ordersFound}\n• Orders to process: ${syncResult.ordersToProcess}\n\nAll orders are up to date!`,
                ephemeral: true
            });
            return;
        }

        // Store the orders for confirmation
        this.pendingData.set(interaction.user.id, {
            type: 'sync_orders',
            orders: syncResult.orders,
            timestamp: Date.now()
        });

        // Create confirmation embed
        const embed = new EmbedBuilder()
            .setTitle('🔄 Offline Order Sync Results')
            .setDescription(`Found ${syncResult.ordersToProcess} orders that need notifications:`)
            .setColor('#ffaa00')
            .setTimestamp();

        // Add order details
        const orderDetails = syncResult.orders.slice(0, 10).map(order => 
            `• **${order.order_number}** - ${order.line_items[0]?.name || 'Unknown Product'} ($${order.total_price})`
        ).join('\n');

        embed.addFields({
            name: '📦 Recent Orders',
            value: orderDetails + (syncResult.orders.length > 10 ? '\n... and more' : ''),
            inline: false
        });

        embed.addFields({
            name: '📊 Summary',
            value: `• Total found: ${syncResult.ordersFound}\n• To process: ${syncResult.ordersToProcess}\n• Time window: Last 24 hours`,
            inline: false
        });

        // Create confirmation buttons
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_sync_orders')
                    .setLabel('✅ Send Notifications')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('cancel_sync_orders')
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.editReply({
            embeds: [embed],
            components: [buttons],
            ephemeral: true
        });

    } catch (error) {
        console.error('❌ Error in sync offline orders:', error);
        await interaction.editReply({
            content: '❌ An error occurred while syncing orders. Please try again.',
            ephemeral: true
        });
    }
}

// Handle sync stats button
async function handleSyncStats(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        console.log('📊 User requested sync stats');
        
        // Check if offline sync is available
        if (!this.offlineSync) {
            await interaction.editReply({
                content: '❌ Offline sync service not initialized.',
                ephemeral: true
            });
            return;
        }

        // Get sync statistics
        const stats = await this.offlineSync.getSyncStats(24);
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Offline Sync Statistics')
            .setDescription('Current sync status and history')
            .setColor('#00ff00')
            .setTimestamp();

        embed.addFields(
            {
                name: '🔄 Last 24 Hours',
                value: `Unprocessed orders: ${stats.totalProcessed}`,
                inline: true
            },
            {
                name: '📦 Last Processed Order',
                value: stats.lastProcessedOrder,
                inline: true
            },
            {
                name: '⏰ Last Sync',
                value: stats.lastProcessedAt,
                inline: true
            }
        );

        await interaction.editReply({
            embeds: [embed],
            ephemeral: true
        });

    } catch (error) {
        console.error('❌ Error getting sync stats:', error);
        await interaction.editReply({
            content: '❌ An error occurred while getting sync stats.',
            ephemeral: true
        });
    }
}

// Handle confirm sync orders button
async function handleConfirmSyncOrders(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        console.log('✅ User confirmed sync orders');
        
        // Get stored data
        const userData = this.pendingData.get(interaction.user.id);
        if (!userData || userData.type !== 'sync_orders') {
            await interaction.editReply({
                content: '❌ No pending sync data found. Please try the sync again.',
                ephemeral: true
            });
            return;
        }

        const { orders } = userData;
        
        // Clear pending data
        this.pendingData.delete(interaction.user.id);

        // Start processing
        const result = await this.offlineSync.processApprovedOrders(orders);
        
        const embed = new EmbedBuilder()
            .setTitle('🎉 Sync Complete!')
            .setDescription('Offline orders have been processed and notifications sent.')
            .setColor('#00ff00')
            .setTimestamp();

        embed.addFields(
            {
                name: '✅ Successfully Processed',
                value: result.processedCount.toString(),
                inline: true
            },
            {
                name: '❌ Failed',
                value: result.failedCount.toString(),
                inline: true
            },
            {
                name: '📬 Notifications',
                value: 'Sent to notification channel with 2-second delays',
                inline: false
            }
        );

        await interaction.editReply({
            embeds: [embed],
            ephemeral: true
        });

    } catch (error) {
        console.error('❌ Error confirming sync orders:', error);
        await interaction.editReply({
            content: '❌ An error occurred while processing orders.',
            ephemeral: true
        });
    }
}

// Handle cancel sync orders button
async function handleCancelSyncOrders(interaction) {
    try {
        // Clear pending data
        this.pendingData.delete(interaction.user.id);
        
        await interaction.update({
            content: '❌ Sync cancelled. No notifications were sent.',
            embeds: [],
            components: [],
            ephemeral: true
        });

    } catch (error) {
        console.error('❌ Error cancelling sync orders:', error);
        await interaction.followUp({
            content: '❌ An error occurred while cancelling the sync.',
            ephemeral: true
        });
    }
}

module.exports = {
    handleSyncOfflineOrders,
    handleSyncStats,
    handleConfirmSyncOrders,
    handleCancelSyncOrders
};



