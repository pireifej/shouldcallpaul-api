const { Expo } = require('expo-server-sdk');

// Create a new Expo SDK client
const expo = new Expo();

/**
 * Send a push notification to a user with receipt handling
 * @param {string} pushToken - The Expo push token (starts with ExponentPushToken[...])
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional data payload
 * @returns {Promise<object>} - Returns { success: boolean, shouldRemoveToken: boolean, error: string }
 */
async function sendPushNotification(pushToken, title, body, data = {}) {
  // Check if the token is valid
  if (!Expo.isExpoPushToken(pushToken)) {
    console.error(`Push token ${pushToken} is not a valid Expo push token`);
    return { 
      success: false, 
      shouldRemoveToken: true, 
      error: 'Invalid Expo push token format' 
    };
  }

  // Construct the notification message
  const message = {
    to: pushToken,
    sound: 'default',
    title: title,
    body: body,
    data: data,
    priority: 'high',
    channelId: 'default',
  };

  try {
    // Send the notification and get ticket
    const ticketChunk = await expo.sendPushNotificationsAsync([message]);
    const ticket = ticketChunk[0];
    
    // Check the ticket for immediate errors
    if (ticket.status === 'error') {
      console.error('❌ Push notification ticket error:', ticket);
      
      // Check if it's a device not registered error (invalid/expired token)
      if (ticket.details?.error === 'DeviceNotRegistered') {
        console.log('🗑️  Device not registered - token should be removed');
        return { 
          success: false, 
          shouldRemoveToken: true, 
          error: 'DeviceNotRegistered' 
        };
      }
      
      // Other errors might be retryable
      return { 
        success: false, 
        shouldRemoveToken: false, 
        error: ticket.message || 'Unknown error' 
      };
    }
    
    // Ticket sent successfully - now poll for receipt to confirm delivery
    console.log('✅ Push notification ticket received:', ticket.id);
    
    // Wait a bit for Expo to process the notification
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Poll for receipt to check actual delivery status
    try {
      const receiptIds = [ticket.id];
      const receipts = await expo.getPushNotificationReceiptsAsync(receiptIds);
      const receipt = receipts[ticket.id];
      
      if (receipt) {
        if (receipt.status === 'error') {
          console.error('❌ Push notification receipt error:', receipt);
          
          // Check for DeviceNotRegistered in receipt (most common place to find it)
          if (receipt.details?.error === 'DeviceNotRegistered') {
            console.log('🗑️  Device not registered (from receipt) - token should be removed');
            return { 
              success: false, 
              shouldRemoveToken: true, 
              error: 'DeviceNotRegistered' 
            };
          }
          
          // Other receipt errors (MessageTooBig, MessageRateExceeded, etc.)
          return { 
            success: false, 
            shouldRemoveToken: false, 
            error: receipt.message || 'Receipt error' 
          };
        }
        
        // Receipt shows successful delivery
        console.log('✅ Push notification delivered successfully');
        return { 
          success: true, 
          shouldRemoveToken: false, 
          ticketId: ticket.id,
          receiptStatus: receipt.status
        };
      }
      
      // Receipt not ready yet - treat as pending success
      console.log('⏳ Push notification receipt pending');
      return { 
        success: true, 
        shouldRemoveToken: false, 
        ticketId: ticket.id,
        receiptStatus: 'pending'
      };
      
    } catch (receiptError) {
      console.error('❌ Error fetching receipt:', receiptError);
      // Ticket was accepted, but couldn't verify receipt - treat as tentative success
      return { 
        success: true, 
        shouldRemoveToken: false, 
        ticketId: ticket.id,
        receiptStatus: 'unknown',
        error: receiptError.message
      };
    }
    
  } catch (error) {
    console.error('❌ Error sending push notification:', error);
    
    // Network errors or other transient issues - don't remove token
    return { 
      success: false, 
      shouldRemoveToken: false, 
      error: error.message 
    };
  }
}

module.exports = { sendPushNotification };
