'use strict';
const express = require('express');

module.exports = function blogRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, openai, uploadImage, uploadImageFromUrl, multer, path, log } = ctx;

router.post('/getAllBlogArticles', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["tz"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // PostgreSQL timezone conversion query (converting from UTC to specified timezone)
    const query = `
      SELECT 
        id, 
        preview, 
        title, 
        image, 
        (created_datetime AT TIME ZONE 'UTC' AT TIME ZONE $1) as timestamp 
      FROM public.blog_article 
      ORDER BY created_datetime DESC
    `;
    
    const result = await pool.query(query, [params.tz]);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getUserByEmail - Get user by email address

router.post('/getBlogArticle', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["id", "tz"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // PostgreSQL query to get blog article — content served from DB
    const query = `
      SELECT 
        title, 
        preview, 
        image,
        content,
        (created_datetime AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp 
      FROM public.blog_article 
      WHERE id = $1
    `;
    
    const result = await pool.query(query, [params.id, params.tz]);
    
    if (result.rows.length === 0) {
      return res.json({error: 1, result: "Blog article not found"});
    }
    
    const articleData = result.rows[0];
    
    res.json({error: 0, result: {
      title: articleData.title,
      content: articleData.content,
      date: articleData.timestamp,
      image: articleData.image
    }});
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({error: 1, result: 'Internal server error'});
  }
});

// POST /login - User authentication endpoint

const upload = multer({ storage: multer.memoryStorage() });

// Admin endpoint to create a new blog article
router.post('/admin/createBlogArticle', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { title, content, author, imageFilename } = req.body;
    
    // Validate required fields
    if (!title || !content) {
      return res.json({ error: 1, result: 'Title and content are required' });
    }
    
    if (!req.file) {
      return res.json({ error: 1, result: 'Image file is required' });
    }
    
    // Generate filename-safe blog article file name from title (max 20 chars for DB)
    const blogArticleFile = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 20);
    
    // Generate preview text (first 200 characters)
    const preview = content.substring(0, 200).trim() + '...';

    // Upload image to Cloudinary
    const imageUrl = await uploadImage(req.file.buffer, 'blog_articles');

    // Generate the HTML content
    const authorName = author || 'Sherri Rase';
    
    // Convert plain text content to HTML paragraphs
    const paragraphs = content.split('\n\n').filter(p => p.trim());
    let htmlContent = '';
    
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i].trim();
      
      // Check if paragraph contains a URL (likely a call-to-action)
      if (para.includes('http://') || para.includes('https://')) {
        const urlMatch = para.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          const url = urlMatch[0];
          const text = para.replace(url, '').trim();
          htmlContent += `
    <div class="call-to-action">
        <p><strong>${text}</strong></p>
        <p><a href="${url}" target="_blank">Visit for more information</a></p>
    </div>
`;
        }
      }
      // Check if it's a short paragraph (likely a highlight/quote)
      else if (para.length < 300 && i > 0 && i < paragraphs.length - 1) {
        htmlContent += `
    <div class="highlight">
        <p>${para}</p>
    </div>
`;
      }
      // Regular paragraph
      else {
        htmlContent += `
    <p>${para}</p>
`;
      }
    }
    
    const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: Georgia, serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        h1 {
            color: #2c3e50;
            border-bottom: 2px solid #c0392b;
            padding-bottom: 10px;
        }
        p {
            margin-bottom: 18px;
            text-align: justify;
        }
        .byline {
            font-style: italic;
            color: #7f8c8d;
            font-size: 0.9em;
        }
        .highlight {
            background-color: #fdf6f0;
            padding: 15px;
            border-left: 4px solid #c0392b;
            margin: 20px 0;
        }
        .image-container {
            text-align: center;
            margin: 20px 0;
        }
        .image-container img {
            max-width: 100%;
            height: auto;
            border-radius: 5px;
        }
        .image-caption {
            font-style: italic;
            color: #7f8c8d;
            font-size: 0.85em;
            text-align: center;
            margin-top: -10px;
            margin-bottom: 20px;
        }
        a {
            color: #c0392b;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .call-to-action {
            background-color: #fdf6f0;
            padding: 15px;
            border-left: 4px solid #c0392b;
            margin: 20px 0;
            text-align: center;
        }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <p class="byline">by ${authorName} for Urban Telegraph</p>

${htmlContent}
</body>
</html>`;
    
    // Get the next available ID
    const maxIdResult = await pool.query('SELECT MAX(id) as max_id FROM public.blog_article');
    const nextId = (maxIdResult.rows[0].max_id || 0) + 1;
    
    // Insert into database — content stored in DB, no flat file needed
    const insertQuery = `
      INSERT INTO public.blog_article (id, created_datetime, title, blog_article_file, preview, image, content)
      VALUES ($1, NOW(), $2, $3, $4, $5, $6)
      RETURNING id
    `;
    
    const result = await pool.query(insertQuery, [
      nextId,
      title,
      blogArticleFile,
      preview,
      imageUrl,
      htmlTemplate
    ]);
    
    console.log(`✅ Blog article created successfully: ID ${nextId}`);
    
    res.json({
      error: 0,
      result: 'Blog article created successfully',
      articleId: nextId,
      blogArticleFile: blogArticleFile,
      imageUrl: imageUrl
    });
    
  } catch (error) {
    console.error('Error creating blog article:', error);
    res.status(500).json({ error: 1, result: error.message });
  }
});

// Admin endpoint to edit an existing blog article
router.patch('/admin/editBlogArticle', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { id, content, title, author } = req.body;

    if (!id) {
      return res.json({ error: 1, result: 'Article id is required' });
    }

    // Fetch existing article from DB
    const existing = await pool.query('SELECT * FROM public.blog_article WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.json({ error: 1, result: 'Article not found' });
    }
    const article = existing.rows[0];

    // Handle optional new image upload to Cloudinary
    let newImageUrl = null;
    if (req.file) {
      newImageUrl = await uploadImage(req.file.buffer, req.file.mimetype, 'blog_articles');
    }

    // Content is stored in DB — no flat file write needed

    // Build DB update — only update fields that were provided
    const updates = [];
    const values = [];
    let idx = 1;

    if (title) { updates.push(`title = $${idx++}`); values.push(title); }
    if (content) {
      updates.push(`content = $${idx++}`); values.push(content);
      const newPreview = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 200) + '...';
      updates.push(`preview = $${idx++}`); values.push(newPreview);
    }
    if (newImageUrl) { updates.push(`image = $${idx++}`); values.push(newImageUrl); }

    if (updates.length > 0) {
      values.push(id);
      await pool.query(
        `UPDATE public.blog_article SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    console.log(`✅ Blog article ${id} updated`);
    res.json({
      error: 0,
      result: 'Article updated successfully',
      articleId: parseInt(id),
      newImageUrl: newImageUrl || null
    });

  } catch (error) {
    console.error('Error editing blog article:', error);
    res.status(500).json({ error: 1, result: error.message });
  }
});

// Admin endpoint to delete a blog article
router.delete('/admin/deleteBlogArticle', authenticate, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.json({ error: 1, result: 'Article id is required' });
    }

    // Fetch article to get the flat file name
    const existing = await pool.query('SELECT * FROM public.blog_article WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.json({ error: 1, result: 'Article not found' });
    }
    const article = existing.rows[0];

    // Delete flat file
    const filePath = path.join(__dirname, 'blog_articles', article.blog_article_file + '.txt');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  Deleted file: ${filePath}`);
    }

    // Delete DB row
    await pool.query('DELETE FROM public.blog_article WHERE id = $1', [id]);

    console.log(`✅ Blog article ${id} deleted`);
    res.json({
      error: 0,
      result: 'Article deleted successfully',
      articleId: parseInt(id)
    });

  } catch (error) {
    console.error('Error deleting blog article:', error);
    res.status(500).json({ error: 1, result: error.message });
  }
});

// Migration endpoint removed for security after successful data import

// POST /sendBroadcastNotification - Send push notification to all users with valid tokens

  return router;
};
