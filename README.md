# VRChat Worlds Data Fetcher

A Node.js background worker that fetches VRChat worlds data every hour and stores it in JSON files with enhanced user data collection and daily organization.

## Features

- Fetches worlds data for 3 sort types: `popularity`, `heat`, `hotness`
- Retrieves 500 worlds per sort type (5 pages × 100 worlds)
- **NEW: Daily file organization** - Organizes data by date in daily files
- **NEW: User data fetching** - Fetches creator details for all worlds using VRChat `/users/{userId}` API
- **NEW: Data processing** - Removes unwanted fields and adds timestamps
- **NEW: Rate limiting** - Smart deduplication and spacing for user API calls
- **NEW: Email notifications** - Sends startup notifications and daily data reports via email
- **NEW: Robust email delivery** - Handles failures with unsent data queue and retry mechanism
- Runs automatically every hour
- Manual trigger endpoint
- Automatic authentication handling
- Rate limiting protection
- Separates scheduled vs manual data
- Maintains backward compatibility with existing file structure

## Setup

1. Set environment variables in Render:
   ```
   VRCHAT_USERNAME=your_vrchat_username
   VRCHAT_PASSWORD=your_vrchat_password
   PORT=3000 (optional, Render sets this automatically)
   IMMEDIATE_START=true (optional, set to false to disable immediate start)
   ```

2. Deploy to Render as a Background Worker

## Email Configuration

The application includes robust email notifications for startup events and daily data delivery:

### Features
- **Startup Notification**: Sends an email when the server starts
- **Daily Data Reports**: Automatically emails daily data as compressed ZIP attachments every 24 hours
- **Failure Recovery**: Stores unsent emails in a queue and retries them on restart
- **Manual Controls**: API endpoints to manually send emails or retry failed sends

### Email Settings
The email configuration is hardcoded for the specific use case:
- **Recipient**: abdellahbardichwork@gmail.com
- **Sender**: abdellahbardichwork@gmail.com (Gmail with App Password)
- **SMTP**: Gmail service with authentication

### Email Schedule
- **Startup**: Immediate notification when service starts
- **Daily Reports**: Every 24 hours with previous day's data
- **Retry Logic**: Automatic retry on restart if previous emails failed

### Manual Email Controls
```bash
# Send email for specific date
curl -X POST http://localhost:3000/send-email \
  -H "Content-Type: application/json" \
  -d '{"date":"2025-08-13"}'

# Retry all unsent emails
curl -X POST http://localhost:3000/retry-emails
```

## File Structure

```
data/
├── scheduled/        # Hourly automatic fetches (legacy format)
├── manual/          # Manual trigger fetches (legacy format)
└── fetch_log.txt    # Execution log

daily-data/           # NEW: Daily organized data with user info
├── 2025-08-13.json  # Contains worlds + user data for the day
├── 2025-08-14.json
└── ...

email-queue/          # NEW: Email failure recovery
└── unsent.json      # Queue of unsent daily data emails
```

## API Endpoints

- `GET /status` - Check service status and last run time (includes email status)
- `POST /trigger` - Manually trigger a data fetch
- `POST /send-email` - Manually send daily data email for a specific date
- `POST /retry-emails` - Retry sending all unsent emails from the queue

## Data Format

### Legacy Format (data/scheduled/, data/manual/)
Each JSON file contains:
```json
{
  "timestamp": "2025-01-01T12:00:00.000Z",
  "type": "scheduled",
  "totalRequests": 15,
  "data": {
    "popularity": [...],
    "heat": [...],
    "hotness": [...]
  },
  "summary": {
    "popularity": 500,
    "heat": 500,
    "hotness": 500
  }
}
```

### Daily Format (daily-data/)
Each daily file contains:
```json
{
  "date": "2025-08-13",
  "lastUpdated": "2025-08-13T14:30:00.000Z",
  "worlds": [
    {
      "id": "wrld_...",
      "name": "World Name",
      "authorId": "usr_...",
      "fetchTimestamp": "2025-08-13T14:30:00.000Z",
      // ... other world data (udonProducts and unityPackages removed)
    }
  ],
  "users": {
    "usr_...": {
      "id": "usr_...",
      "displayName": "Creator Name",
      "fetchTimestamp": "2025-08-13T14:35:00.000Z",
      // ... other user data
    }
  }
}
```

## Rate Limiting

### World Data
- 2 seconds between page requests
- 3 seconds between sort types
- 30 second backoff on rate limit (429)

### User Data
- 1 second between user requests
- 30 second backoff on rate limit (429)
- Smart deduplication of user IDs across all worlds
- User data fetched after successful world fetch jobs
- Skips users already fetched on the same day

## Render Configuration

- **Service Type**: Background Worker
- **Build Command**: (leave empty)
- **Start Command**: `npm start`
- **Instance Type**: Starter (512MB RAM should be sufficient)
- **Region**: Any
- **Environment Variables**: Set VRCHAT_USERNAME and VRCHAT_PASSWORD

## Manual Testing

After deployment, you can:
1. Check status: `curl https://your-app.onrender.com/status`
2. Trigger manual fetch: `curl -X POST https://your-app.onrender.com/trigger`

## Logs

Monitor the Render logs to see:
- Authentication status
- Fetch progress
- Rate limiting notifications
- Error messages

## Notes

- The service authenticates on startup and re-authenticates if tokens expire
- Files are timestamped and organized by type (scheduled/manual)
- Total of 15 requests per hour (3 sorts × 5 pages)
- Data is stored in memory-efficient JSON format