'use strict';
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

const html = `
<p>Hi Gatita,</p>
<p>Good news — your Pray Over Us account has been fully restored and you can post prayer requests again! 🙏</p>
<p>As a quick reminder, we do ask that members try to stick to <strong>one prayer request per day or less</strong>, and that requests stay focused on genuine spiritual or personal needs. This helps keep the wall a meaningful space for everyone in the community.</p>
<p>You can read our full posting guidelines here:</p>
<p style="text-align:center;margin:24px 0;">
  <a href="https://prayoverus.com/prayer-guidelines.html" style="background:#3498db;color:#ffffff;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:1rem;">
    📖 Read the Prayer Request Guidelines
  </a>
</p>
<p>We are glad to have you back and we are praying with you. Thank you for being part of the community. 💛</p>
<hr>
<p><strong>With love in Christ,</strong><br>Paul &amp; The Pray Over Us Team</p>
`;

transporter.sendMail({
  from: process.env.GMAIL_USER,
  to: 'baxibaxicous@gmail.com',
  subject: '🙏 Your Pray Over Us Account Has Been Restored',
  html
}, (err, info) => {
  if (err) { console.error('Error:', err.message); process.exit(1); }
  else { console.log('Sent:', info.response); process.exit(0); }
});
