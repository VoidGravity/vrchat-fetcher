# VRChat Worlds Data Fetcher

A Node.js background worker that fetches VRChat worlds data every hour and stores it in JSON files with enhanced user data collection and daily organization.

## Features

- Fetches worlds data for 3 sort types: `popularity`, `heat`, `hotness`
- Retrieves 500 worlds per sort type (5 pages × 100 worlds)
- **NEW: Daily file organization** - Organizes data by date in daily files
- **NEW: User data fetching** - Fetches creator details for all worlds using VRChat `/users/{userId}` API
- **NEW: Data processing** - Removes unwanted fields and adds timestamps
- **NEW: Rate limiting** - Smart deduplication and spacing for user API calls
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
```

## API Endpoints

- `GET /status` - Check service status and last run time
- `POST /trigger` - Manually trigger a data fetch

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

## Data Analysis

### World Statistics Aggregation

The repository includes a comprehensive aggregation script that analyzes all daily data files to produce world statistics:

```bash
# Run aggregation with default settings
npm run aggregate

# Or with custom options
node aggregate_stats.js --min-occurrences 5 --top 20
```

**Features:**
- Calculates average occupants and occurrence counts for all worlds
- Provides global statistics (average, highest, lowest occurrences)
- Flexible sorting and filtering options
- Detailed JSON output with comprehensive world data

See [AGGREGATION.md](AGGREGATION.md) for detailed documentation and usage examples.

**Example Output:**
```
📊 Aggregation Results Summary:
Total unique worlds: 11
Average occurrences per world: 3.91
Highest avg occupants: 70
Average avg occupants: 19.11

🏆 Top 5 Worlds by avgOccupants:
1. Quiet Space - Avg: 70 | Occurrences: 7
2. Game World - Avg: 55.86 | Occurrences: 7
```