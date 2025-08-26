const ShopifyAPIService = require('./api');
const db = require('../database/db');
const config = require('../config');

class OfflineOrderSync {
    constructor(messageQueue, logger) {
        this.api = new ShopifyAPIService();
        this.messageQueue = messageQueue;
        this.logger = logger;
    }

    // Sync orders that were created while bot was offline
    async syncOfflineOrders(syncWindowHours = 24) {
        try {
            console.log(`🔄 Starting offline order sync for last ${syncWindowHours} hours...`);

            // Calculate sync window
            const syncStartDate = new Date();
            syncStartDate.setHours(syncStartDate.getHours() - syncWindowHours);

            // Test API connection first
            const connectionTest = await this.api.testConnection();
            if (!connectionTest.success) {
                throw new Error(`Shopify API connection failed: ${connectionTest.error}`);
            }

            console.log(`✅ Connected to Shopify store: ${connectionTest.shop}`);

            // Fetch orders from API
            const orders = await this.api.getOrdersCreatedAfter(syncStartDate);
            
            if (orders.length === 0) {
                console.log('✅ No orders found in sync window');
                return {
                    success: true,
                    ordersFound: 0,
                    ordersToProcess: 0,
                    orders: []
                };
            }

            console.log(`📊 Found ${orders.length} orders from Shopify API`);

            // Filter out already processed orders
            const unprocessedOrders = [];
            for (const order of orders) {
                const isProcessed = await db.isOrderProcessed(order.id);
                if (!isProcessed) {
                    unprocessedOrders.push(order);
                }
            }

            console.log(`📊 Found ${unprocessedOrders.length} unprocessed orders`);

            return {
                success: true,
                ordersFound: orders.length,
                ordersToProcess: unprocessedOrders.length,
                orders: unprocessedOrders
            };

        } catch (error) {
            console.error('❌ Error during offline order sync:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Offline order sync');
            }
            throw error;
        }
    }

    // Process and queue notifications for approved orders
    async processApprovedOrders(orders) {
        try {
            console.log(`🚀 Processing ${orders.length} approved offline orders...`);

            let processedCount = 0;
            let failedCount = 0;

            for (const order of orders) {
                try {
                    // Track order in database
                    await db.trackOrder({
                        id: order.id,
                        email: order.email,
                        order_number: order.order_number,
                        total_price: order.total_price,
                        currency: order.currency_code,
                        financial_status: order.financial_status
                    });

                    // Mark order as processed
                    await db.markOrderProcessed(order.id, order.order_number, 'api_sync');

                    // Process each line item
                    for (const lineItem of order.line_items) {
                        await this.processOrderLineItem(order, lineItem);
                    }

                    // Add delay between orders to avoid spam
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay

                    processedCount++;
                    console.log(`✅ Processed order ${order.order_number}`);

                } catch (error) {
                    console.error(`❌ Failed to process order ${order.order_number}:`, error);
                    failedCount++;
                }
            }

            console.log(`🎉 Offline sync complete: ${processedCount} processed, ${failedCount} failed`);
            return { processedCount, failedCount };

        } catch (error) {
            console.error('❌ Error processing approved orders:', error);
            if (this.logger) {
                await this.logger.logError(error, 'Approved orders processing');
            }
            throw error;
        }
    }

    // Process a single order line item (same logic as webhook)
    async processOrderLineItem(orderData, lineItem) {
        try {
            // Get product details
            const product = {
                id: lineItem.product_id,
                name: lineItem.name,
                price: lineItem.price,
                image_url: lineItem.image_url || null,
                product_id: lineItem.product_id
            };

            // Get category for product
            const category = await this.getProductCategory(product);

            // Create order notification message
            const orderMessage = `Someone ordered **${product.name}**!\n@https://levellinked.myshopify.com/products/${product.product_id}`;

            // Queue notification to channel
            if (this.messageQueue) {
                await this.messageQueue.addMessage({
                    type: 'order',
                    target_type: 'channel',
                    target_id: config.discord.notificationChannelId,
                    message_data: JSON.stringify({ content: orderMessage }),
                    priority: 2 // High priority for order notifications
                });
                
                console.log(`✅ Offline order notification queued for ${product.name}`);
            }

            // Mark notification as sent
            await db.markNotificationSent(orderData.id);

            return true;

        } catch (error) {
            console.error('❌ Error processing offline order line item:', error);
            return false;
        }
    }

    // Get product category (same logic as webhook)
    async getProductCategory(product) {
        try {
            const categories = await db.getCategories();
            
            // Try to match by product ID or name
            for (const category of categories) {
                if (category.shopify_collection_id && product.product_id === category.shopify_collection_id) {
                    return category;
                }
                
                if (category.shopify_tags && product.name) {
                    const categoryTags = category.shopify_tags.toLowerCase().split(',');
                    const productName = product.name.toLowerCase();
                    
                    for (const tag of categoryTags) {
                        if (productName.includes(tag.trim())) {
                            return category;
                        }
                    }
                }
            }
            
            // Return fallback category
            return categories.find(cat => cat.fallback_category) || categories[0] || null;
            
        } catch (error) {
            console.error('❌ Error getting product category:', error);
            return null;
        }
    }

    // Get sync statistics
    async getSyncStats(syncWindowHours = 24) {
        try {
            const syncStartDate = new Date();
            syncStartDate.setHours(syncStartDate.getHours() - syncWindowHours);

            const totalProcessed = await db.getUnprocessedOrdersCount(syncStartDate);
            const lastProcessed = await db.getLastProcessedOrder();

            return {
                totalProcessed,
                lastProcessedOrder: lastProcessed?.order_number || 'None',
                lastProcessedAt: lastProcessed?.processed_at || 'Never',
                syncWindow: `${syncWindowHours} hours`
            };

        } catch (error) {
            console.error('❌ Error getting sync stats:', error);
            throw error;
        }
    }
}

module.exports = OfflineOrderSync;
