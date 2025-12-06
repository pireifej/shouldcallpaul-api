# Overview

This project is a comprehensive prayer and blog platform, featuring an Express.js API server with a PostgreSQL database backend. It serves as a mobile/web prayer community application, a blog CMS for static content, and provides public resume/portfolio data endpoints for the shouldcallpaul.com personal website. The platform enables authenticated users to share prayer requests, receive community support, and stay connected through email notifications and push notifications.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## API Server Architecture

**Framework Choice**: Express.js for a lightweight, flexible Node.js RESTful API.
**Database Integration**: PostgreSQL with `pg` library for connection pooling, configured via `DATABASE_URL`.
**Authentication System**: Bcrypt for password hashing, session management, user registration, and login.

## Core Features

### Prayer Request System
- **Community Interaction**: Users can view and "pray for" community prayer requests (excluding their own).
- **Personal Management**: Users can submit, view, and edit their own prayer requests.
- **Notifications**: Push notifications are sent when someone prays for a request; admin receives email alerts for new requests.
- **Content Validation**: Prayer requests prevent submissions with email addresses or URLs.
- **Church Filtering**: Supports client-side filtering of prayer requests by `church_id`.
- **Privacy Option**: `my_church_only` flag allows users to restrict visibility of prayer requests to their own church members only.

### Blog CMS
- **Static Content**: Blog articles and images are stored as HTML files in `blog_articles/`.
- **API Endpoints**: RESTful endpoints serve blog content and metadata.

### Email Notification System
- **Service Provider**: MailerSend API for email delivery.
- **Rate Limiting**: 600ms delay between emails to adhere to MailerSend's 120 requests/min limit.
- **Personalization**: Emails use `real_name` (or `user_name`, then "Friend") for greetings.
- **Broadcast Capabilities**: Supports test and production modes for sending personalized emails to all users with custom templates.

### Resume/Portfolio Data Endpoints
- **Purpose**: Provides structured JSON data for shouldcallpaul.com.
- **Content**: Includes workshops, conferences, speeches, projects, races, and patent information.
- **Storage**: Static JSON files and associated images in `resume_data/`.

### Image Uploads
- **Profile Pictures**: Users can upload profile pictures (JPG, PNG, WEBP) to Cloudinary.
- **Prayer Request Images**: Prayer requests can include images uploaded to Cloudinary.
- **Security**: Images are validated before storage; Cloudinary handles persistent storage and CDN delivery.

## Technical Design Decisions

### Email Management
- **Rate Limiting**: Per-email delay strategy for MailerSend to prevent API rate limit breaches.
- **Duplicate Prevention**: Dynamic CC list construction to avoid duplicate email addresses in TO/CC fields.

### Database Design
- **ID Management**: Manual `MAX(id)+1` pattern for tables without auto-increment.
- **User Fields**: `real_name` for formal names, `user_name` for display.
- **Idempotency Keys**: Database table `idempotency_keys` prevents duplicate prayer request submissions. Keys auto-expire after 1 hour.

### Push Notification System
- **Provider**: Expo Push Notifications for free and unlimited push notifications.
- **Token Management**: Stores Expo push tokens in `user.fcm_token`; automatically cleans up invalid/expired tokens via receipt polling.
- **Triggers**: Notifications sent when someone prays for a user's request.

# External Dependencies

### Core Services
- **PostgreSQL**: Primary database system (Neon-backed Replit database).
- **MailerSend**: Email delivery service.
- **Expo Push Notifications**: Mobile push notification service.
- **Cloudinary**: Cloud-based image management and CDN.

### Node.js Libraries
- **express**: Web server framework.
- **pg**: PostgreSQL client.
- **bcrypt**: Password hashing.
- **dotenv**: Environment variable management.
- **cors**: Cross-origin resource sharing.
- **mailersend**: MailerSend SDK.
- **expo-server-sdk**: Expo SDK for push notifications.
- **multer**: Multipart/form-data handling.

### Environment Configuration
- **DATABASE_URL**: PostgreSQL connection string.
- **MAILERSEND_API_KEY**: MailerSend API key.
- **CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET**: Cloudinary credentials.
- **PORT**: Server port.