// Advanced Shopify Discord Bot - Main Entry Point
// This file replaces the simple webhook server with our full-featured bot

console.log('🚀 Starting Advanced Shopify Discord Bot...');

// Import and start the advanced bot
const bot = require('./src/bot');

// Self-ping mechanism to prevent Render from sleeping
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes in milliseconds

function setupSelfPing() {
  // Try multiple ways to get the service URL
  let serviceUrl = process.env.RENDER_EXTERNAL_URL || 
                   process.env.RENDER_SERVICE_URL || 
                   process.env.RENDER_EXTERNAL_HOSTNAME;
  
  // If we have RENDER_SERVICE_NAME, construct the URL
  if (!serviceUrl && process.env.RENDER_SERVICE_NAME) {
    serviceUrl = `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
  }
  
  // Fallback: if we're on Render but don't have the URL, try the known pattern
  if (!serviceUrl && (process.env.RENDER || process.env.IS_PULL_REQUEST !== undefined)) {
    // Known URL from logs: https://shopify-levellinked-webhook.onrender.com
    serviceUrl = 'https://shopify-levellinked-webhook.onrender.com';
    console.log('🔧 Using fallback URL for self-ping');
  }
  
  // Debug logging
  console.log('🔍 Environment check:');
  console.log(`   RENDER_EXTERNAL_URL: ${process.env.RENDER_EXTERNAL_URL || 'not set'}`);
  console.log(`   RENDER_SERVICE_URL: ${process.env.RENDER_SERVICE_URL || 'not set'}`);
  console.log(`   RENDER_EXTERNAL_HOSTNAME: ${process.env.RENDER_EXTERNAL_HOSTNAME || 'not set'}`);
  console.log(`   RENDER_SERVICE_NAME: ${process.env.RENDER_SERVICE_NAME || 'not set'}`);
  console.log(`   RENDER: ${process.env.RENDER || 'not set'}`);
  console.log(`   IS_PULL_REQUEST: ${process.env.IS_PULL_REQUEST || 'not set'}`);
  console.log(`   Resolved service URL: ${serviceUrl || 'not found'}`);
  
  if (!serviceUrl) {
    console.log('⚠️ No service URL found, self-ping disabled (probably running locally)');
    return;
  }

  const pingUrl = `${serviceUrl}/health`;
  
  console.log(`🏓 Setting up self-ping to ${pingUrl} every 14 minutes`);
  
  setInterval(async () => {
    try {
      const response = await fetch(pingUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Shopify-Bot-KeepAlive/1.0'
        }
      });
      
      if (response.ok) {
        console.log(`✅ Self-ping successful at ${new Date().toISOString()}`);
      } else {
        console.log(`⚠️ Self-ping responded with status: ${response.status}`);
      }
    } catch (error) {
      console.log(`❌ Self-ping failed: ${error.message}`);
    }
  }, PING_INTERVAL);
  
  // Initial ping after 2 minutes to ensure service is fully started
  setTimeout(async () => {
    try {
      const response = await fetch(pingUrl);
      console.log(`🎯 Initial self-ping completed with status: ${response.status}`);
    } catch (error) {
      console.log(`🎯 Initial self-ping failed: ${error.message}`);
    }
  }, 2 * 60 * 1000);
}

// The bot will automatically start when this file is imported
// All the sophisticated features are now available:
// - Real-time order notifications with product categorization
// - Smart auto-DM system with 65-minute delay
// - Dual admin control panels (hidden from regular members)
// - Advanced analytics and member tracking
// - Professional webhook handling with signature verification
// - Comprehensive database system

console.log('✅ Advanced bot system loaded successfully');
console.log('📡 Webhook server will be available at /webhook');
console.log('❤️ Health check available at /health');
console.log('🤖 Discord bot will connect automatically');

// Start the self-ping mechanism
setupSelfPing();