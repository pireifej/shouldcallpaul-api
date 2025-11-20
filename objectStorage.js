// Object Storage Service for Replit App Storage
// Based on blueprint:javascript_object_storage - adapted from TypeScript to JavaScript
const { Storage } = require('@google-cloud/storage');
const { randomUUID } = require('crypto');

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

// Initialize object storage client with Replit credentials
const objectStorageClient = new Storage({
  credentials: {
    audience: 'replit',
    subject_token_type: 'access_token',
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: 'external_account',
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: 'json',
        subject_token_field_name: 'access_token',
      },
    },
    universe_domain: 'googleapis.com',
  },
  projectId: '',
});

class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
  }
}

class ObjectStorageService {
  constructor() {}

  // Gets the private object directory from environment
  getPrivateObjectDir() {
    const dir = process.env.PRIVATE_OBJECT_DIR || '';
    if (!dir) {
      throw new Error(
        'PRIVATE_OBJECT_DIR not set. Create a bucket in Object Storage tool and set PRIVATE_OBJECT_DIR env var.'
      );
    }
    return dir;
  }

  // Upload a file buffer to object storage
  async uploadFile(fileBuffer, fileType, category = 'uploads') {
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const ext = this.getExtensionForMimeType(fileType);
    const fullPath = `${privateObjectDir}/${category}/${objectId}${ext}`;

    const { bucketName, objectName } = this.parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    // Upload the file buffer
    await file.save(fileBuffer, {
      contentType: fileType,
      metadata: {
        metadata: {
          'custom:aclPolicy': JSON.stringify({
            visibility: 'public', // Public images for prayer community
          }),
        },
      },
    });

    // Return the object path that can be accessed via /objects/ endpoint
    return `/objects/${category}/${objectId}${ext}`;
  }

  // Get file extension from MIME type
  getExtensionForMimeType(mimeType) {
    const extensions = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
    };
    return extensions[mimeType] || '.jpg';
  }

  // Gets the object entity file from the object path
  async getObjectEntityFile(objectPath) {
    if (!objectPath.startsWith('/objects/')) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join('/');
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = this.parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  // Download an object and stream it to the response
  async downloadObject(file, res, cacheTtlSec = 3600) {
    try {
      // Get file metadata
      const [metadata] = await file.getMetadata();

      // Set appropriate headers
      res.set({
        'Content-Type': metadata.contentType || 'application/octet-stream',
        'Content-Length': metadata.size,
        'Cache-Control': `public, max-age=${cacheTtlSec}`,
      });

      // Stream the file to the response
      const stream = file.createReadStream();

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error streaming file' });
        }
      });

      stream.pipe(res);
    } catch (error) {
      console.error('Error downloading file:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error downloading file' });
      }
    }
  }

  // Parse object path into bucket name and object name
  parseObjectPath(path) {
    if (!path.startsWith('/')) {
      path = `/${path}`;
    }
    const pathParts = path.split('/');
    if (pathParts.length < 3) {
      throw new Error('Invalid path: must contain at least a bucket name');
    }

    const bucketName = pathParts[1];
    const objectName = pathParts.slice(2).join('/');

    return {
      bucketName,
      objectName,
    };
  }
}

module.exports = { ObjectStorageService, ObjectNotFoundError };
