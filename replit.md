# Overview

This project is a comprehensive prayer and blog platform featuring an Express.js API server with PostgreSQL database backend. The system serves multiple purposes: a mobile/web prayer community application, a blog CMS for static content, and public resume/portfolio data endpoints for the shouldcallpaul.com personal website. The platform enables authenticated users to share prayer requests, receive community support, and stay connected through email notifications.

# User Preferences

Preferred communication style: Simple, everyday language.

# Recent Changes (November 2025)

- **November 18, 2025**: Implemented church filter support and image upload functionality
  - **Church Filter Feature**: Added church_id to API responses for client-side filtering
    - Updated `/login` endpoint to include `church_id` in user response object
    - Enhanced all prayer request endpoints to include `church_id` field:
      - `/getRequestFeed` - Returns church_id of request creator
      - `/getMyRequests` - Returns church_id of request creator
      - `/getCommunityWall` - Returns church_id of request creator
    - Mobile app can now filter prayers by church affiliation (client-side filtering)
    - Backward compatible: existing clients unaffected by additional field
  - **Image Upload Functionality**:
  - **Profile Pictures**: New `/uploadProfilePicture` endpoint for secure image uploads from mobile app
    - Accepts multipart/form-data with image files (JPG, PNG, WEBP up to 5MB)
    - Stores images in `/public/profile-pictures/` with `{userId}_profile.{ext}` naming convention
    - Added new database column `profile_picture_url` to user table
    - Updates both `profile_picture_url` (new) and `picture` (legacy) for backward compatibility
    - Security: Uses memory storage with validation before disk writes to prevent path traversal attacks
    - Enhanced `/getUser` to return `profile_picture_url` field
  - **Prayer Request Images**: Enhanced `/createRequestAndPrayer` to accept images
    - Now handles both JSON (existing) and multipart/form-data (new with images)
    - Stores images in `/public/prayer-images/` with `{requestId}_prayer.{ext}` naming convention
    - Updates `request.picture` field with image URL after request creation
    - All fetch endpoints (`/getRequestFeed`, `/getMyRequests`, `/getCommunityWall`) return `request_picture`
    - Same security approach as profile pictures: memory storage, validation, cleanup on errors
  - Created `/updateUser` endpoint for profile editing (user_about, user_title, church_id, email)
  - Enhanced `/getAllUsers` to include church_id and church_name for each user

- **November 20, 2025**: Migrated image storage to Replit App Storage (Object Storage)
  - **Critical fix**: Images now persist across production deployments (previously lost on restarts)
  - Created `objectStorage.js` service for Google Cloud Storage integration via Replit
  - Migrated `/uploadProfilePicture` and `/createRequestAndPrayer` to use object storage
  - Added `/objects/*` endpoint to serve uploaded images from persistent storage
  - Environment: `PRIVATE_OBJECT_DIR=/request-images` bucket for all user uploads
  - Image URLs now: `https://shouldcallpaul.replit.app/objects/{category}/{uuid}.{ext}`
  - Configurable base URL via `BASE_URL` environment variable for multi-environment support
  - Improved error handling: upload failures now return proper HTTP 500 errors
  - Categories: `profile-pictures` for user avatars, `prayer-images` for prayer requests

- **November 20, 2025**: Migrated from Firebase Cloud Messaging to Expo Push Notifications
  - Removed firebase-admin dependency (143 packages uninstalled)
  - Created `pushNotifications.js` helper with Expo SDK integration
  - Implemented receipt polling to detect invalid/expired device tokens
  - Enhanced `/prayFor` to automatically remove invalid Expo tokens from database
  - `/registerFCMToken` endpoint now accepts Expo tokens (endpoint name kept for backward compatibility)
  - Database columns unchanged: `user.fcm_token` stores Expo tokens, `settings.push_notifications` still respected
  - Push notification flow: send → wait 1s → poll receipt → cleanup invalid tokens
  - Added email updating capability to `/updateUser` endpoint with uniqueness validation

- **November 11, 2025**: Initial push notification system
  - Created `/registerFCMToken` endpoint for mobile apps to register device tokens
  - Enhanced `/prayFor` endpoint to send push notifications when someone prays for a request
  - Added database columns: `user.fcm_token`, `user.fcm_token_updated`, `settings.push_notifications`
  - Respects user privacy settings for push notification preferences
  - Implemented admin notification email for new prayer request creation

- **October 17, 2025**: Fixed broadcast email rate limiting to comply with MailerSend's 120 requests/min limit
  - Changed from batch-based delays to per-email delays (600ms between each email = 100 emails/min)
  - Fixed duplicate email address issue in TO/CC fields by making CC list dynamic
  - Added progress logging every 10 emails for better monitoring

- **Previous updates**: Created broadcast email system with personalization, added blog articles, added Career Day workshop entry, fixed getCommunityWall endpoint, removed all user_family table references

# System Architecture

## API Server Architecture

**Framework Choice**: Express.js provides a lightweight, flexible Node.js web server ideal for RESTful APIs. The server binds to `0.0.0.0:5000` to ensure public accessibility in the Replit environment.

**Database Integration**: PostgreSQL database with connection pooling via `pg` library. Environment variable `DATABASE_URL` manages connection configuration for both development and production environments.

**Authentication System**: User authentication with bcrypt password hashing, session management, and secure endpoints for user registration and login.

## Core Features

### Prayer Request System
- **Community Prayer Wall**: Users can view prayer requests from other community members (excluding their own requests)
- **Personal Requests**: Users can submit, view, and manage their own prayer requests
- **Prayer Response**: Community members can "pray for" requests, with tracking of who has prayed
- **Push Notifications**: Mobile users receive instant push notifications when someone prays for their requests
- **Admin Notifications**: Paul receives email alerts whenever a new prayer request is created

### Blog CMS
- **Static Content**: Blog articles stored as HTML files with associated images in `blog_articles/` directory
- **Image Management**: Blog images stored in `blog_articles/img/` for organized content delivery
- **Article Endpoints**: RESTful API endpoints serve blog content and metadata

### Email Notification System
- **Service Provider**: MailerSend API for professional email delivery
- **Rate Limiting Strategy**: 600ms delay between each email (100 emails/min) to safely stay under the 120 requests/min API limit
- **Personalization**: Emails use recipient's `real_name` field (fallback to `user_name` then "Friend") for personalized greetings
- **CC Tracking**: Broadcasts CC both `paul@prayoverus.com` and `prayoverus@gmail.com` with dynamic duplicate prevention (avoids duplicating the TO recipient in CC list)
- **Broadcast Capabilities**: 
  - Test mode: Single email to `paul@prayoverus.com`
  - Production mode: Individual emails to all users with personalized content
  - Custom email templates with logo, personalized body, and call-to-action buttons
- **Error Handling**: Individual email failure tracking with detailed error logging

### Resume/Portfolio Data Endpoints
- **Purpose**: Serve structured JSON data for the shouldcallpaul.com personal website
- **Data Categories**: Workshops, conferences, speeches, projects, races, and patent information
- **File Storage**: Static JSON files in `resume_data/` directory with associated images
- **Recent Addition**: Career Day at Indian Hill workshop (May 30, 2025) with two images

## Technical Design Decisions

### Email Rate Limiting
**Problem**: MailerSend enforces a 120 requests/min rate limit. Initial batch-based approach (100 emails instantly, 2s pause) exceeded this limit at ~50 emails/second.

**Solution**: Per-email delay of 600ms ensures 100 emails/min sending rate, safely under the API limit. Delays are maintained even on individual email failures to prevent rate limit violations.

### Email Duplicate Prevention
**Problem**: MailerSend rejects emails with the same address in both TO and CC fields.

**Solution**: Dynamic CC list construction checks the TO recipient and excludes them from the CC array, ensuring no duplicates while maintaining tracking requirements.

### Database Design
- **ID Management**: Manual ID generation using `MAX(id)+1` pattern for tables without auto-increment
- **User Fields**: `real_name` field for formal names, `user_name` for display/fallback
- **Environment Separation**: Development database accessible via tools; production requires manual intervention

## External Dependencies

### Core Services
- **PostgreSQL**: Primary database system (Neon-backed Replit database)
- **MailerSend**: Email delivery service with API key management via environment secrets
- **Expo Push Notifications**: Free, unlimited push notification service for mobile apps

### Node.js Libraries
- **express**: Web server framework
- **pg**: PostgreSQL client for database operations
- **bcrypt**: Password hashing for secure authentication
- **dotenv**: Environment variable management
- **cors**: Cross-origin resource sharing for API access
- **mailersend**: Official MailerSend SDK for email delivery
- **openai**: OpenAI API integration for AI features
- **expo-server-sdk**: Expo Server SDK for push notifications
- **multer**: Multipart/form-data handling for file uploads

### Environment Configuration
- **DATABASE_URL**: PostgreSQL connection string (automatically configured by Replit)
- **MAILERSEND_API_KEY**: API key for email service (stored in environment secrets)
- **PORT**: Server port (defaults to 5000)

### Static Assets
- **profile_images/**: User profile images and platform logo (`pray_over_us_logo.jpg`)
- **blog_articles/**: HTML blog content and images
- **resume_data/**: JSON portfolio data and associated images

## API Endpoint Categories

1. **Authentication**: User registration, login, session management
2. **Prayer Requests**: Create, read, update prayer requests; community wall access
3. **Blog**: Retrieve blog articles and metadata
4. **Email**: Broadcast notifications to user base
5. **Push Notifications**: Expo token registration and mobile push notifications
6. **Resume Data**: Public endpoints for portfolio information
7. **Debug**: Database connectivity and health checks

## Push Notification System

### Architecture
Expo Push Notifications provide free, unlimited push notifications to mobile devices. The system:
- Stores Expo push tokens in the `user.fcm_token` column (kept for backward compatibility)
- Respects user preferences via `settings.push_notifications`
- Automatically cleans up invalid/expired tokens via receipt polling
- Sends high-priority notifications for immediate delivery
- Polls receipts 1 second after sending to verify delivery

### Implementation
- **pushNotifications.js**: Helper module with Expo SDK integration
- **Receipt Polling**: Checks delivery status and detects DeviceNotRegistered errors
- **Token Cleanup**: Automatically removes invalid tokens from database
- **Error Handling**: Distinguishes between permanent failures and retryable errors

### Endpoints
- **POST /registerFCMToken**: Mobile apps register their Expo push token
  - Parameters: `userId`, `fcmToken` (accepts Expo tokens despite name)
  - Updates `user.fcm_token` and `user.fcm_token_updated`
  - Note: Endpoint name kept for backward compatibility with existing mobile apps
  
### Notification Triggers
- **Prayer Response**: When someone prays for a user's request
  - Title: "Someone prayed for you 🙏"
  - Body: "[Name] just prayed for your request"
  - Includes request ID and user data for deep linking

### Database Schema
- `user.fcm_token` (VARCHAR 255): Expo push token (column name kept for backward compatibility)
- `user.fcm_token_updated` (TIMESTAMP): Last token update time
- `settings.push_notifications` (BOOLEAN): User preference for push notifications

The architecture prioritizes reliability, security, and scalability while maintaining simplicity in deployment and maintenance within the Replit environment.
