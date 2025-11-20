const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadImage(fileBuffer, folder = 'uploads', resourceType = 'image') {
  try {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: folder,
          resource_type: resourceType,
          allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
        },
        (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
            reject(error);
          } else {
            console.log(`✅ Cloudinary upload successful: ${result.secure_url}`);
            resolve(result.secure_url);
          }
        }
      );
      
      uploadStream.end(fileBuffer);
    });
  } catch (error) {
    console.error('Failed to upload to Cloudinary:', error);
    throw error;
  }
}

module.exports = { uploadImage };
