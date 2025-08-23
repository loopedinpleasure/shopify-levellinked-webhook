const crypto = require('crypto');
const config = require('../config');
const db = require('../database/db');

class ShopifyWebhooks {
    constructor(client) {
        this.client = client;
        this.webhookSecret = config.shopify.webhookSecret;
    }

    // Verify webhook signature for security
    verifyWebhook(body, signature) {
        try {
            const hmac = crypto.createHmac('sha256', this.webhookSecret);
            hmac.update(body, 'utf8');
            const expectedSignature = 'sha256=' + hmac.digest('hex');
            
            return crypto.timingSafeEqual(
                Buffer.from(signature),
                Buffer.from(expectedSignature)
            );
        } catch (error) {
            console.error('Webhook verification error:', error);
            return false;
        }
    }

    // Handle order created webhook
    async handleOrderCreated(orderData) {
        try {
            console.log('🛍️ Processing new order:', orderData.order_number);

            // Track order in database
            await db.trackOrder({
                id: orderData.id,
                email: orderData.email,
                order_number: orderData.order_number,
                total_price: orderData.total_price,
                currency: orderData.currency_code,
                financial_status: orderData.financial_status
            });

            // Process each line item
            for (const lineItem of orderData.line_items) {
                await this.processOrderLineItem(orderData, lineItem);
            }

            // Record analytics
            await db.recordEvent('order', 'webhook', {
                order_number: orderData.order_number,
                total_price: orderData.total_price,
                currency: orderData.currency_code
            }, parseFloat(orderData.total_price));

            console.log('✅ Order processed successfully');
        } catch (error) {
            console.error('❌ Error processing order:', error);
            throw error;
        }
    }

    // Process individual line items
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

            // Categorize product
            const category = await this.categorizeProduct(lineItem);

            // Create order notification
            const embed = await this.createOrderNotification(orderData, product, category);

            // Send to Discord notification channel
            const channel = this.client.channels.cache.get(config.discord.notificationChannelId);
            if (channel) {
                await channel.send({ embeds: [embed] });
                console.log(`📢 Order notification sent for ${product.name}`);
            } else {
                console.warn('❌ Notification channel not found');
            }

        } catch (error) {
            console.error('❌ Error processing line item:', error);
        }
    }

    // Create order notification embed
    async createOrderNotification(orderData, product, category) {
        const { createOrderEmbed } = require('../discord/embeds');
        return await createOrderEmbed(orderData, product, category);
    }

    // Categorize product based on Shopify data
    async categorizeProduct(lineItem) {
        try {
            // Get categories from database
            const categories = await db.getCategories();
            
            // Try to match by product tags first
            if (lineItem.product_tags && lineItem.product_tags.length > 0) {
                const tags = lineItem.product_tags.join(',').toLowerCase();
                
                for (const category of categories) {
                    if (category.shopify_tags) {
                        const categoryTags = category.shopify_tags.toLowerCase().split(',');
                        if (categoryTags.some(tag => tags.includes(tag.trim()))) {
                            return category;
                        }
                    }
                }
            }

            // Try to match by product type
            if (lineItem.product_type) {
                const productType = lineItem.product_type.toLowerCase();
                
                for (const category of categories) {
                    if (category.shopify_tags) {
                        const categoryTags = category.shopify_tags.toLowerCase().split(',');
                        if (categoryTags.some(tag => productType.includes(tag.trim()))) {
                            return category;
                        }
                    }
                }
            }

            // Try to match by collection
            if (lineItem.collections && lineItem.collections.length > 0) {
                for (const collection of lineItem.collections) {
                    for (const category of categories) {
                        if (category.shopify_collection_id === collection.id) {
                            return category;
                        }
                    }
                }
            }

            // Fallback to default category
            const defaultCategory = categories.find(cat => cat.fallback_category);
            if (defaultCategory) {
                return defaultCategory;
            }

            // If no default category, create a general one
            return {
                name: 'General',
                emoji: '🛒',
                shopify_tags: '',
                fallback_category: true
            };

        } catch (error) {
            console.error('❌ Error categorizing product:', error);
            // Return general category as fallback
            return {
                name: 'General',
                emoji: '🛒',
                shopify_tags: '',
                fallback_category: true
            };
        }
    }

    // Get category color for embeds
    getCategoryColor(categoryName) {
        const colors = {
            'Adult Toys': '#ff69b4',
            'Accessories': '#4169e1',
            'General': '#00ff00'
        };
        
        return colors[categoryName] || '#00ff00';
    }

    // Generic webhook handler
    async handleWebhook(topic, body, signature) {
        try {
            // Verify webhook signature
            if (!this.verifyWebhook(body, signature)) {
                console.warn('❌ Webhook signature verification failed');
                return { success: false, error: 'Invalid signature' };
            }

            console.log(`📡 Processing webhook: ${topic}`);

            // Handle different webhook topics
            switch (topic) {
                case 'orders/create':
                case 'orders/updated':
                    if (body.financial_status === 'paid') {
                        await this.handleOrderCreated(body);
                    } else {
                        console.log(`⏳ Order ${body.order_number} not paid yet (${body.financial_status})`);
                    }
                    break;

                case 'orders/fulfilled':
                    console.log(`✅ Order ${body.order_number} fulfilled`);
                    // Could add fulfillment notifications here
                    break;

                case 'products/create':
                case 'products/update':
                    console.log(`📦 Product ${body.title} ${topic.includes('create') ? 'created' : 'updated'}`);
                    break;

                default:
                    console.log(`ℹ️ Unhandled webhook topic: ${topic}`);
            }

            return { success: true };

        } catch (error) {
            console.error('❌ Webhook processing error:', error);
            return { success: false, error: error.message };
        }
    }

    // Health check method
    async getHealthStatus() {
        try {
            const lastOrder = await db.get(`
                SELECT order_number, created_at 
                FROM orders 
                ORDER BY created_at DESC 
                LIMIT 1
            `);

            return {
                status: 'healthy',
                lastOrder: lastOrder ? `${lastOrder.order_number} (${lastOrder.created_at})` : 'None',
                webhookSecret: !!this.webhookSecret,
                database: true
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                webhookSecret: !!this.webhookSecret,
                database: false
            };
        }
    }
}

module.exports = ShopifyWebhooks;
