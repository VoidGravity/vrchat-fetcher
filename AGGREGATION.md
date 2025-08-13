# VRChat World Statistics Aggregation

This script analyzes all daily VRChat world data files to produce comprehensive statistics about world popularity and occupancy.

## Overview

The aggregation script (`aggregate_stats.js`) scans all daily data files in the `daily-data/` directory and produces detailed statistics for each world across the three VRChat categories (popularity, heat, hotness).

## Features

- **World Aggregation**: Combines all data points for each unique world across all daily files
- **Occupancy Analysis**: Calculates average, minimum, and maximum occupants for each world
- **Occurrence Tracking**: Counts how many times each world appears in the dataset
- **Global Statistics**: Provides overall statistics for comparison
- **Flexible Sorting**: Sort results by average occupants, occurrences, maximum occupants, or name
- **Filtering Options**: Filter worlds by minimum occurrence count
- **Detailed Output**: Saves comprehensive results to JSON file

## Usage

### Basic Usage
```bash
# Run with default settings
npm run aggregate

# Or directly with node
node aggregate_stats.js
```

### Advanced Options
```bash
# Show help
node aggregate_stats.js --help

# Filter worlds with at least 5 occurrences, show top 20
node aggregate_stats.js --min-occurrences 5 --top 20

# Sort by most frequent worlds instead of highest occupancy
node aggregate_stats.js --sort occurrences

# Custom output file
node aggregate_stats.js --output my_stats.json

# Use different data directory
node aggregate_stats.js --data-dir /path/to/data
```

## Output Format

The script generates a JSON file (default: `aggregated_stats.json`) with the following structure:

```json
{
  "generatedAt": "2025-08-13T21:41:19.668Z",
  "filters": {
    "minOccurrences": 1,
    "sortBy": "avgOccupants"
  },
  "summary": {
    "totalWorlds": 11,
    "avgOccurrences": 3.91,
    "highestOccurrences": 10,
    "lowestOccurrences": 1,
    "avgAvgOccupants": 19.11,
    "highestAvgOccupants": 70,
    "lowestAvgOccupants": 0,
    "dataFiles": 5,
    "totalDataPoints": 43,
    "filteredWorlds": 11,
    "unfilteredWorlds": 11
  },
  "worlds": [
    {
      "id": "wrld_56789",
      "name": "Quiet Space",
      "authorId": "usr_55555",
      "authorName": "Creator5",
      "occupantReadings": [
        {
          "occupants": 70,
          "timestamp": "2025-08-15T10:00:00.000Z",
          "sourceFile": "2025-08-15.json",
          "heat": 8,
          "popularity": 125,
          "hotness": 15
        }
      ],
      "totalOccupants": 490,
      "occurrences": 7,
      "tags": ["relaxation", "meditation"],
      "firstSeen": "2025-08-15T10:00:00.000Z",
      "lastSeen": "2025-08-17T14:00:00.000Z",
      "avgOccupants": 70,
      "maxOccupants": 79,
      "minOccupants": 64
    }
  ]
}
```

## CLI Options

- `--data-dir <path>`: Directory containing daily data files (default: `daily-data`)
- `--output <file>`: Output file path (default: `aggregated_stats.json`)
- `--sort <field>`: Sort by `avgOccupants`, `occurrences`, `maxOccupants`, or `name` (default: `avgOccupants`)
- `--min-occurrences <num>`: Minimum occurrences to include world (default: 1)
- `--top <num>`: Number of top worlds to display in console output (default: 10)
- `--help`, `-h`: Show help message

## Understanding the Data

### World Statistics
- **avgOccupants**: Average number of occupants across all data points for this world
- **occurrences**: Total number of times this world appears in the dataset
- **maxOccupants/minOccupants**: Highest and lowest occupancy recorded
- **occupantReadings**: Array of all individual data points with timestamps

### Global Statistics
- **totalWorlds**: Number of unique worlds in the dataset
- **avgOccurrences**: Average number of times each world appears
- **avgAvgOccupants**: Overall average occupancy across all worlds
- **dataFiles**: Number of daily files processed
- **totalDataPoints**: Total number of world entries processed

## Use Cases

1. **Identify Most Popular Worlds**: Find worlds with highest average occupancy
2. **Track World Consistency**: Find worlds that appear frequently in the data
3. **Compare World Performance**: Analyze how different worlds perform over time
4. **Data Quality Assessment**: Understand data collection patterns and completeness

## Example Analysis

```bash
# Find worlds that consistently appear in data (minimum 10 occurrences)
node aggregate_stats.js --min-occurrences 10 --sort occurrences

# Find worlds with highest peak occupancy
node aggregate_stats.js --sort maxOccupants --top 5

# Export filtered results for external analysis
node aggregate_stats.js --min-occurrences 3 --output popular_worlds.json
```

This tool provides valuable insights into VRChat world popularity patterns and helps identify trends in user engagement across different worlds.