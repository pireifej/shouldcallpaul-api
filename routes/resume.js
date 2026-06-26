'use strict';
const express = require('express');

function isSpam(text) {
  if (!text || typeof text !== 'string') return { isSpam: false };
  if (/[^\x00-\x7F]{10,}/.test(text)) {
    return { isSpam: true, reason: 'Contains random character strings' };
  }
  if (/(.)\1{8,}/.test(text)) {
    return { isSpam: true, reason: 'Suspicious text pattern detected' };
  }
  if (/\b[a-f0-9]{32,}\b/i.test(text)) {
    return { isSpam: true, reason: 'Contains suspicious ID-like strings' };
  }
  const nonAlpha = (text.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (nonAlpha / text.length > 0.4) {
    return { isSpam: true, reason: 'Text has unusual character distribution' };
  }
  if (text.split(' ').some(w => w.length > 50)) {
    return { isSpam: true, reason: 'Contains unusually long strings' };
  }
  return { isSpam: false };
}

module.exports = function resumeRoutes(ctx) {
  const router = express.Router();
  const { authenticate, sendGmailSingle, fs, path } = ctx;

router.post('/contact', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Honeypot field - if filled, it's a bot (frontend should have hidden field named 'website')
    if (params.website && params.website.length > 0) {
      console.log('🚫 Spam blocked: Honeypot triggered');
      return res.json({ error: 0, result: "Contact message sent successfully" }); // Fake success
    }
    
    // Validate required parameters
    const requiredParams = ["subject", "to", "content"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({ error: "Required parameter '" + requiredParam + "' missing" });
      }
    }
    
    // Check for spam in subject and content
    const subjectSpamCheck = isSpam(params.subject);
    const contentSpamCheck = isSpam(params.content);
    
    if (subjectSpamCheck.isSpam) {
      console.log(`🚫 Spam blocked in subject: ${subjectSpamCheck.reason}`);
      return res.json({ error: 0, result: "Contact message sent successfully" }); // Fake success to not alert bots
    }
    
    if (contentSpamCheck.isSpam) {
      console.log(`🚫 Spam blocked in content: ${contentSpamCheck.reason}`);
      return res.json({ error: 0, result: "Contact message sent successfully" }); // Fake success to not alert bots
    }
    
    // Define sender (same as prayer notifications)
    const fromPerson = { 
      email: "prayoverus@gmail.com", 
      name: "PrayOverUs" 
    };
    
    // Recipient from parameter
    const toPerson = {
      email: params.to,
      name: "Recipient"
    };
    
    // Create HTML template for contact message
    const emailTemplate = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Website Contact Message</h2>
        <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #3498db; margin: 20px 0;">
          <p><strong>Subject:</strong> ${params.subject}</p>
        </div>
        <div style="margin: 20px 0; line-height: 1.6;">
          <p><strong>Message:</strong></p>
          <div style="background-color: #ffffff; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
            ${params.content}
          </div>
        </div>
        <p>This message was sent through the PrayOverUs.com contact form.</p>
        <hr style="border: 1px solid #eee; margin: 20px 0;">
        <p style="color: #7f8c8d; font-size: 12px;">
          Sent from PrayOverUs.com contact system
        </p>
      </div>
    `;
    
    // Send the email
    const emailResult = await sendGmailSingle(
      emailTemplate,
      fromPerson,
      toPerson,
      `Contact: ${params.subject}`,
      null,
      null
    );
    
    if (emailResult.error === 0) {
      res.json({ 
        error: 0, 
        result: "Contact message sent successfully" 
      });
    } else {
      res.json({ 
        error: 1, 
        result: emailResult.result 
      });
    }
    
  } catch (error) {
    console.error('Error in /contact endpoint:', error);
    res.json({ error: error.message });
  }
});

// GET /resume/:filename - Serve resume JSON files
router.get('/resume/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Sanitize filename to prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    // Add .json extension if not provided
    const jsonFilename = filename.endsWith('.json') ? filename : filename + '.json';
    const filePath = path.join(__dirname, 'resume_data', jsonFilename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Resume file not found' });
    }
    
    // Read and return JSON file
    const jsonData = fs.readFileSync(filePath, 'utf8');
    const parsedData = JSON.parse(jsonData);
    
    res.json(parsedData);
    
  } catch (error) {
    console.error('Error serving resume file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /registerFCMToken - Register or update a user's Expo push token for push notifications
// NOTE: Endpoint name kept as "registerFCMToken" for backward compatibility

  return router;
};
