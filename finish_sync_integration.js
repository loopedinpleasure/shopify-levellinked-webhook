const fs = require('fs');
const path = require('path');

// Read the bot.js file
const botFilePath = path.join(__dirname, 'src', 'bot.js');
let content = fs.readFileSync(botFilePath, 'utf8');

console.log('🔧 Finishing offline order sync integration...');

// Add the sync cases to the switch statement
// Find the cancel_send case and add sync cases before it
const syncCases = `
                case 'sync_offline_orders':
                    await this.handleSyncOfflineOrders(interaction);
                    break;
                case 'sync_stats':
                    await this.handleSyncStats(interaction);
                    break;
                case 'confirm_sync_orders':
                    await this.handleConfirmSyncOrders(interaction);
                    break;
                case 'cancel_sync_orders':
                    await this.handleCancelSyncOrders(interaction);
                    break;
                case 'cancel_send':`;

// Replace the cancel_send case
content = content.replace(/                case 'cancel_send':/g, syncCases);

// Add the sync handler methods at the end of the class (before the closing brace)
const syncHandlers = `
    // Handle sync offline orders
    async handleSyncOfflineOrders(interaction) {
        const { handleSyncOfflineOrders } = require('./bot_sync_handlers');
        await handleSyncOfflineOrders.call(this, interaction);
    }

    // Handle sync stats
    async handleSyncStats(interaction) {
        const { handleSyncStats } = require('./bot_sync_handlers');
        await handleSyncStats.call(this, interaction);
    }

    // Handle confirm sync orders
    async handleConfirmSyncOrders(interaction) {
        const { handleConfirmSyncOrders } = require('./bot_sync_handlers');
        await handleConfirmSyncOrders.call(this, interaction);
    }

    // Handle cancel sync orders
    async handleCancelSyncOrders(interaction) {
        const { handleCancelSyncOrders } = require('./bot_sync_handlers');
        await handleCancelSyncOrders.call(this, interaction);
    }
}`;

// Find the end of the class and add the handlers
const classEndPattern = /^}$/m;
const match = content.match(classEndPattern);
if (match) {
    // Add handlers before the closing brace
    content = content.replace(/^}$/m, syncHandlers + '\n}');
}

// Write the updated content back to the file
fs.writeFileSync(botFilePath, content, 'utf8');

console.log('✅ Successfully added sync functionality to bot.js');
console.log('🎉 Offline order sync integration is now complete!');
