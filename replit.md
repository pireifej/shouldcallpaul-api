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
- **Faith Points System**: Gamified point system stored in `user.faith_points`. Points awarded: 1 for praying for someone, 3 for posting a prayer request, 5 for posting a request with an image. Returned in login, getUser, getUserByEmail, getUsersByChurch responses and in `prayed_by_people` objects.
- **Faith Rank System**: Server-side rank computation via `faith_ranks` table and `computeRank()` helper. Ranks cached in memory. A `faith_rank` object (level, title, icon, points, next_rank, progress) is included wherever `faith_points` is returned. `GET /getFaithRanks` returns the full rank ladder. 11 ranks from Newcomer (0 pts) to Prayer Warrior (1000 pts).
- **Church Member Directory**: `POST /getUsersByChurch` returns all active users for a given `churchId` with profile info and faith rank.

### Pray Over Us Pro
- **Source of truth**: RevenueCat project `Pray Over Us` and its `Pray Over Us Pro` entitlement. The backend does not store entitlement state.
- **Subscriber identity**: Pro-aware requests accept `revenuecatAppUserId`. A confirmed active identity is linked to the database user for later checks.
- **User sessions**: Successful email, generic social, Google, and Apple login responses include `user_session_token` at the top level and in the returned user object. User-owned prayer and premium requests send it in `x-user-session-token`; the backend derives `userId` from the signed token.
- **Status endpoint**: Authenticated `POST /api/subscriptions/pro-status` accepts `userId` and optional `revenuecatAppUserId`.
- **Prayer generation**: Authenticated `POST /api/prayers/generate` accepts `extended` (default `false`). Standard prayers are 3-4 sentences and about 60-90 words. Extended 250-350 word prayers require Pro.
- **Posting**: `POST /api/prayers/post` is an alias of the legacy creation route. Free users may create one request per UTC day across all clients; Pro users are unlimited.
- **Premium content**: `POST /api/daily-bread`, `POST /api/prayer-walk/stream`, and legacy full-content/audio equivalents require active Pro. Public `GET /getDailyDevotional` returns metadata-only preview data.
- **Free-tier response**: A second request returns HTTP 403 with `error: "DAILY_LIMIT_REACHED"`.

### Blog CMS
- **Database-backed Content**: Blog articles are stored in the `blog_article` table (`content TEXT` column). Flat files in `blog_articles/` exist as legacy backups but are unused.
- **API Endpoints**: RESTful endpoints serve blog content and metadata.
- **Admin Endpoints**: `POST /admin/createBlogArticle` (generates full HTML from plain text, uploads image to Cloudinary), `PATCH /admin/editBlogArticle`, `DELETE /admin/deleteBlogArticle`. Auth: Basic Auth.

### Email Notification System
- **Service Provider**: Gmail SMTP via Nodemailer (`createGmailTransporter()`). MailerSend has been fully removed.
- **Rate Limiting**: 600ms delay between emails during broadcasts.
- **Personalization**: Emails use `real_name` (or `user_name`, then "Friend") for greetings.
- **Broadcast Capabilities**: `POST /sendBroadcastEmail` supports test mode (`includeAllUsers: false` sends to GMAIL_USER only) and production mode (`includeAllUsers: true` sends to all users).

### Resume/Portfolio Data Endpoints
- **Purpose**: Provides structured JSON data for shouldcallpaul.com.
- **Content**: Includes workshops, conferences, speeches, projects, races, and patent information.
- **Storage**: Static JSON files and associated images in `resume_data/`.

### CRM Workshop API
- **Endpoints**: Authenticated `GET/POST /api/workshops` and `GET/PUT/PATCH/DELETE /api/workshops/:id`.
- **Venue fields**: `venue_name` and `venue_address` are nullable text fields returned by workshop list/detail APIs and accepted by create/update APIs.
- **Structured fees**: `fee_amount` is a nullable non-negative number and `fee_type` is nullable with values `flat`, `hour`, or `session`.
- **Legacy fee compatibility**: `cost_basis` remains in all workshop responses. Recognized values such as `$75`, `$75/hour`, and `$50/session` populate the structured fee fields. Saving a complete structured fee synchronizes `cost_basis`.
- **Partial updates**: Both PUT and PATCH update only fields included in the request. An omitted field is unchanged; an explicit `null` clears a nullable field. Unrecognized legacy `cost_basis` text is preserved during unrelated updates.

### Image Uploads
- **Profile Pictures**: Users can upload profile pictures (JPG, PNG, WEBP) to Cloudinary.
- **Prayer Request Images**: Prayer requests can include images uploaded to Cloudinary.
- **Security**: Images are validated before storage; Cloudinary handles persistent storage and CDN delivery.

## Technical Design Decisions

### Email Management
- **Rate Limiting**: 600ms per-email delay during broadcasts to stay within Gmail's sending limits.
- **Duplicate Prevention**: Dynamic CC list construction to avoid duplicate email addresses in TO/CC fields.

### Database Design
- **ID Management**: Manual `MAX(id)+1` pattern for tables without auto-increment.
- **User Fields**: `real_name` for formal names, `user_name` for display.

### Push Notification System
- **Provider**: Expo Push Notifications for free and unlimited push notifications.
- **Token Management**: Stores Expo push tokens in `user.fcm_token`; automatically cleans up invalid/expired tokens via receipt polling.
- **Triggers**: Notifications sent when someone prays for a user's request.

# External Dependencies

### Core Services
- **PostgreSQL**: Primary database system (Neon-backed Replit database).
- **Gmail SMTP**: Email delivery via Nodemailer using a Gmail account and App Password.
- **Expo Push Notifications**: Mobile push notification service.
- **Cloudinary**: Cloud-based image management and CDN.
- **RevenueCat**: Subscription entitlement validation through the Replit connector.

### Node.js Libraries
- **express**: Web server framework.
- **pg**: PostgreSQL client.
- **bcrypt**: Password hashing.
- **dotenv**: Environment variable management.
- **cors**: Cross-origin resource sharing.
- **nodemailer**: Gmail SMTP email sending.
- **expo-server-sdk**: Expo SDK for push notifications.
- **multer**: Multipart/form-data handling.
- **@replit/connectors-sdk**: Server-side access to the configured RevenueCat connection.

### Environment Configuration
- **DATABASE_URL**: PostgreSQL connection string (dev).
- **NEON_DATABASE_URL**: PostgreSQL connection string (production).
- **GMAIL_USER, GMAIL_APP_PASSWORD**: Gmail SMTP credentials for all email sending.
- **CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET**: Cloudinary credentials.
- **PORT**: Server port.