# Overview

This project is a comprehensive prayer and blog platform featuring an Express.js API server with PostgreSQL database backend. The system serves multiple purposes: a mobile/web prayer community application, a blog CMS for static content, and public resume/portfolio data endpoints for the shouldcallpaul.com personal website. The platform enables authenticated users to share prayer requests, receive community support, and stay connected through email notifications.

# User Preferences

Preferred communication style: Simple, everyday language.

# Recent Changes (October 2025)

- **October 17, 2025**: Fixed broadcast email rate limiting to comply with MailerSend's 120 requests/min limit
  - Changed from batch-based delays to per-email delays (600ms between each email = 100 emails/min)
  - Fixed duplicate email address issue in TO/CC fields by making CC list dynamic
  - Added progress logging every 10 emails for better monitoring

- **Previous updates**: Created broadcast email system with personalization, added blog articles, added Career Day workshop entry, fixed getCommunityWall endpoint

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

### Node.js Libraries
- **express**: Web server framework
- **pg**: PostgreSQL client for database operations
- **bcrypt**: Password hashing for secure authentication
- **dotenv**: Environment variable management
- **cors**: Cross-origin resource sharing for API access
- **mailersend**: Official MailerSend SDK for email delivery
- **openai**: OpenAI API integration for AI features

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
5. **Resume Data**: Public endpoints for portfolio information
6. **Debug**: Database connectivity and health checks

The architecture prioritizes reliability, security, and scalability while maintaining simplicity in deployment and maintenance within the Replit environment.
