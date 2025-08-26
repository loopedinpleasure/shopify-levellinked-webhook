const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { restResources } = require('@shopify/shopify-api/rest/admin/2024-01');
const config = require('../config');

class ShopifyAPIService {
    constructor() {
        // For private apps, we use the access token directly
        // The Shopify API library requires these values even if empty
        this.api = shopifyApi({
            apiKey: 'dummy_key', // Required by library but not used
            apiSecretKey: 'dummy_secret', // Required by library but not used
            scopes: ['read_orders'],
            hostName: process.env.SHOPIFY_SHOP_URL?.replace('https://', '').replace('http://', '') || '',
            apiVersion: LATEST_API_VERSION,
            isEmbeddedApp: false,
            isPrivateApp: true,
            restResources
        });
    }

    // Get orders from a specific date range
    async getOrdersCreatedAfter(startDate) {
        try {
            console.log(`🔄 Fetching orders created after ${startDate.toISOString()}`);
            
            const session = {
                accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
                shop: process.env.SHOPIFY_SHOP_URL?.replace('https://', '').replace('http://', '')
            };

            const client = new this.api.clients.Rest({
                session: session,
            });

            // Convert date to Shopify's expected format (ISO string)
            const startDateStr = startDate.toISOString();
            
            // Fetch orders with specific parameters
            const response = await client.get({
                path: 'orders',
                query: {
                    status: 'any',
                    created_at_min: startDateStr,
                    limit: 250, // Maximum allowed by Shopify
                    fields: 'id,order_number,email,total_price,currency_code,financial_status,created_at,line_items,line_items.product_id,line_items.name,line_items.price,line_items.image_url'
                }
            });

            console.log(`✅ Fetched ${response.body.orders?.length || 0} orders from Shopify API`);
            return response.body.orders || [];

        } catch (error) {
            console.error('❌ Error fetching orders from Shopify API:', error);
            throw error;
        }
    }

    // Get orders from a specific order number onwards (for pagination)
    async getOrdersSinceOrder(orderNumber) {
        try {
            console.log(`🔄 Fetching orders since order #${orderNumber}`);
            
            const session = {
                accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
                shop: process.env.SHOPIFY_SHOP_URL?.replace('https://', '').replace('http://', '')
            };

            const client = new this.api.clients.Rest({
                session: session,
            });

            const response = await client.get({
                path: 'orders',
                query: {
                    status: 'any',
                    since_id: orderNumber,
                    limit: 250,
                    fields: 'id,order_number,email,total_price,currency_code,financial_status,created_at,line_items,line_items.product_id,line_items.name,line_items.price,line_items.image_url'
                }
            });

            console.log(`✅ Fetched ${response.body.orders?.length || 0} orders since order #${orderNumber}`);
            return response.body.orders || [];

        } catch (error) {
            console.error('❌ Error fetching orders since order number:', error);
            throw error;
        }
    }

    // Test API connection
    async testConnection() {
        try {
            const session = {
                accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
                shop: process.env.SHOPIFY_SHOP_URL?.replace('https://', '').replace('http://', '')
            };

            const client = new this.api.clients.Rest({
                session: session,
            });

            // Try to fetch shop info to test connection
            const response = await client.get({
                path: 'shop'
            });

            console.log('✅ Shopify API connection successful');
            return {
                success: true,
                shop: response.body.shop?.name || 'Unknown Shop'
            };

        } catch (error) {
            console.error('❌ Shopify API connection failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = ShopifyAPIService;
