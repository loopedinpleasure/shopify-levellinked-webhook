const config = require('../config');

class ShopifyAPIService {
    constructor() {
        // Store configuration for direct API calls
        this.shopUrl = process.env.SHOPIFY_SHOP_URL?.replace('https://', '').replace('http://', '') || '';
        this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    }

    // Get orders from a specific date range
    async getOrdersCreatedAfter(startDate) {
        try {
            console.log(`🔄 Fetching orders created after ${startDate.toISOString()}`);
            
            // Convert date to Shopify's expected format (ISO string)
            const startDateStr = startDate.toISOString();
            
            // Build the API URL
            const url = `https://${this.shopUrl}/admin/api/2025-07/orders.json?status=any&created_at_min=${startDateStr}&limit=250&fields=id,order_number,email,total_price,currency_code,financial_status,created_at,line_items,line_items.product_id,line_items.name,line_items.price,line_items.image_url`;
            
            // Make direct HTTP request
            const response = await fetch(url, {
                headers: {
                    'X-Shopify-Access-Token': this.accessToken,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            console.log(`✅ Fetched ${data.orders?.length || 0} orders from Shopify API`);
            return data.orders || [];

        } catch (error) {
            console.error('❌ Error fetching orders from Shopify API:', error);
            throw error;
        }
    }

    // Get orders from a specific order number onwards (for pagination)
    async getOrdersSinceOrder(orderNumber) {
        try {
            console.log(`🔄 Fetching orders since order #${orderNumber}`);
            
            // Build the API URL
            const url = `https://${this.shopUrl}/admin/api/2025-07/orders.json?status=any&since_id=${orderNumber}&limit=250&fields=id,order_number,email,total_price,currency_code,financial_status,created_at,line_items,line_items.product_id,line_items.name,line_items.price,line_items.image_url`;
            
            // Make direct HTTP request
            const response = await fetch(url, {
                headers: {
                    'X-Shopify-Access-Token': this.accessToken,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            console.log(`✅ Fetched ${data.orders?.length || 0} orders since order #${orderNumber}`);
            return data.orders || [];

        } catch (error) {
            console.error('❌ Error fetching orders since order number:', error);
            throw error;
        }
    }

    // Test API connection
    async testConnection() {
        try {
            // Build the API URL
            const url = `https://${this.shopUrl}/admin/api/2025-07/shop.json`;
            
            // Make direct HTTP request
            const response = await fetch(url, {
                headers: {
                    'X-Shopify-Access-Token': this.accessToken,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            console.log('✅ Shopify API connection successful');
            return {
                success: true,
                shop: data.shop?.name || 'Unknown Shop'
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
