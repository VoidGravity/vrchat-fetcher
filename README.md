# VRChat Worlds Data Fetcher

A Node.js background worker that fetches VRChat worlds data every hour and stores it in JSON files.

## Features

- Fetches worlds data for 3 sort types: `popularity`, `heat`, `hotness`
- Retrieves 500 worlds per sort type (5 pages × 100 worlds)
- Runs automatically every hour
- Manual trigger endpoint
- Automatic authentication handling
- Rate limiting protection
- Separates scheduled vs manual data

## Setup

1. Set environment variables in Render:
   ```
   VRCHAT_USERNAME=your_vrchat_username
   VRCHAT_PASSWORD=your_vrchat_password
   PORT=3000 (optional, Render sets this automatically)
   IMMEDIATE_START=true (optional, set to false to disable immediate start)
   ```

2. Deploy to Render as a Background Worker

## File Structure

```
data/
├── scheduled/        # Hourly automatic fetches
├── manual/          # Manual trigger fetches
└── fetch_log.txt    # Execution log
```

## API Endpoints

- `GET /status` - Check service status and last run time
- `POST /trigger` - Manually trigger a data fetch

## Data Format

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

## Rate Limiting

- 2 seconds between page requests
- 3 seconds between sort types
- 30 second backoff on rate limit (429)

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