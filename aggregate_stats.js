#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

class WorldStatsAggregator {
    constructor(options = {}) {
        this.dailyDataDir = options.dataDir || 'daily-data';
        this.outputFile = options.outputFile || 'aggregated_stats.json';
        this.sortBy = options.sortBy || 'avgOccupants'; // avgOccupants, occurrences, name
        this.minOccurrences = options.minOccurrences || 1;
        this.topN = options.topN || 10;
    }

    /**
     * Scan all daily data files and load world data
     */
    loadAllWorldData() {
        const worldData = [];
        
        if (!fs.existsSync(this.dailyDataDir)) {
            console.error(`Daily data directory ${this.dailyDataDir} not found`);
            return [];
        }

        const files = fs.readdirSync(this.dailyDataDir)
            .filter(file => file.endsWith('.json'))
            .sort();

        console.log(`Found ${files.length} daily data files`);

        for (const file of files) {
            const filepath = path.join(this.dailyDataDir, file);
            try {
                const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
                if (data.worlds && Array.isArray(data.worlds)) {
                    console.log(`Loading ${data.worlds.length} worlds from ${file}`);
                    worldData.push(...data.worlds.map(world => ({
                        ...world,
                        sourceDate: data.date || file.replace('.json', ''),
                        sourceFile: file
                    })));
                }
            } catch (error) {
                console.warn(`Error reading ${filepath}: ${error.message}`);
            }
        }

        console.log(`Total worlds loaded: ${worldData.length}`);
        return worldData;
    }

    /**
     * Get occupant count from world data, handling different possible field names
     */
    getOccupantCount(world) {
        // Try different field names that might contain occupant data
        return world.occupants || 
               world.publicOccupants || 
               world.capacity ||
               world.heat ||
               world.popularity ||
               0;
    }

    /**
     * Aggregate statistics for all worlds
     */
    aggregateWorldStats(worldData) {
        const worldStats = new Map();

        // Group data by world ID and calculate stats
        for (const world of worldData) {
            const worldId = world.id;
            const occupants = this.getOccupantCount(world);

            if (!worldStats.has(worldId)) {
                worldStats.set(worldId, {
                    id: worldId,
                    name: world.name || 'Unknown',
                    authorId: world.authorId,
                    authorName: world.authorName,
                    occupantReadings: [],
                    totalOccupants: 0,
                    occurrences: 0,
                    tags: world.tags || [],
                    firstSeen: world.fetchTimestamp || world.sourceDate,
                    lastSeen: world.fetchTimestamp || world.sourceDate
                });
            }

            const stats = worldStats.get(worldId);
            stats.occupantReadings.push({
                occupants: occupants,
                timestamp: world.fetchTimestamp,
                sourceFile: world.sourceFile,
                heat: world.heat,
                popularity: world.popularity,
                hotness: world.hotness
            });
            stats.totalOccupants += occupants;
            stats.occurrences += 1;
            
            // Update first/last seen timestamps
            if (world.fetchTimestamp) {
                if (!stats.firstSeen || world.fetchTimestamp < stats.firstSeen) {
                    stats.firstSeen = world.fetchTimestamp;
                }
                if (!stats.lastSeen || world.fetchTimestamp > stats.lastSeen) {
                    stats.lastSeen = world.fetchTimestamp;
                }
            }
        }

        // Calculate averages
        const aggregatedWorlds = [];
        for (const [worldId, stats] of worldStats) {
            const avgOccupants = stats.occurrences > 0 ? stats.totalOccupants / stats.occurrences : 0;
            
            aggregatedWorlds.push({
                ...stats,
                avgOccupants: Math.round(avgOccupants * 100) / 100, // Round to 2 decimal places
                maxOccupants: Math.max(...stats.occupantReadings.map(r => r.occupants)),
                minOccupants: Math.min(...stats.occupantReadings.map(r => r.occupants))
            });
        }

        return aggregatedWorlds;
    }

    /**
     * Calculate global statistics
     */
    calculateGlobalStats(aggregatedWorlds) {
        if (aggregatedWorlds.length === 0) {
            return {
                totalWorlds: 0,
                avgOccurrences: 0,
                highestOccurrences: 0,
                lowestOccurrences: 0,
                avgAvgOccupants: 0,
                highestAvgOccupants: 0,
                lowestAvgOccupants: 0
            };
        }

        const occurrences = aggregatedWorlds.map(w => w.occurrences);
        const avgOccupants = aggregatedWorlds.map(w => w.avgOccupants);

        return {
            totalWorlds: aggregatedWorlds.length,
            avgOccurrences: Math.round((occurrences.reduce((a, b) => a + b, 0) / occurrences.length) * 100) / 100,
            highestOccurrences: Math.max(...occurrences),
            lowestOccurrences: Math.min(...occurrences),
            avgAvgOccupants: Math.round((avgOccupants.reduce((a, b) => a + b, 0) / avgOccupants.length) * 100) / 100,
            highestAvgOccupants: Math.max(...avgOccupants),
            lowestAvgOccupants: Math.min(...avgOccupants)
        };
    }

    /**
     * Main aggregation process
     */
    async aggregate() {
        console.log('Starting VRChat World Statistics Aggregation...');
        console.log('='.repeat(50));

        // Load all world data
        const worldData = this.loadAllWorldData();
        
        if (worldData.length === 0) {
            console.log('No world data found to aggregate');
            return;
        }

        // Aggregate statistics
        console.log('\nAggregating world statistics...');
        const aggregatedWorlds = this.aggregateWorldStats(worldData);
        
        // Filter by minimum occurrences
        const filteredWorlds = aggregatedWorlds.filter(world => world.occurrences >= this.minOccurrences);
        
        // Sort based on specified criteria
        this.sortWorlds(filteredWorlds);

        // Calculate global stats
        const globalStats = this.calculateGlobalStats(filteredWorlds);

        // Prepare output
        const results = {
            generatedAt: new Date().toISOString(),
            filters: {
                minOccurrences: this.minOccurrences,
                sortBy: this.sortBy
            },
            summary: {
                ...globalStats,
                dataFiles: fs.readdirSync(this.dailyDataDir).filter(f => f.endsWith('.json')).length,
                totalDataPoints: worldData.length,
                filteredWorlds: filteredWorlds.length,
                unfilteredWorlds: aggregatedWorlds.length
            },
            worlds: filteredWorlds
        };

        // Save results
        fs.writeFileSync(this.outputFile, JSON.stringify(results, null, 2));
        
        console.log('\n📊 Aggregation Results Summary:');
        console.log('='.repeat(50));
        console.log(`Total unique worlds: ${globalStats.totalWorlds}`);
        console.log(`Total data points: ${worldData.length}`);
        console.log(`Filtered worlds (min ${this.minOccurrences} occurrences): ${filteredWorlds.length}`);
        console.log(`Average occurrences per world: ${globalStats.avgOccurrences}`);
        console.log(`Highest occurrences: ${globalStats.highestOccurrences}`);
        console.log(`Lowest occurrences: ${globalStats.lowestOccurrences}`);
        console.log(`Average avg occupants: ${globalStats.avgAvgOccupants}`);
        console.log(`Highest avg occupants: ${globalStats.highestAvgOccupants}`);
        console.log(`Lowest avg occupants: ${globalStats.lowestAvgOccupants}`);
        
        console.log(`\n🏆 Top ${this.topN} Worlds by ${this.sortBy}:`);
        console.log('='.repeat(50));
        filteredWorlds.slice(0, this.topN).forEach((world, index) => {
            console.log(`${index + 1}. ${world.name} (ID: ${world.id})`);
            console.log(`   Avg Occupants: ${world.avgOccupants} | Occurrences: ${world.occurrences} | Max: ${world.maxOccupants}`);
            console.log('');
        });

        console.log(`\n✅ Results saved to ${this.outputFile}`);
        
        return results;
    }

    /**
     * Sort worlds based on specified criteria
     */
    sortWorlds(worlds) {
        switch (this.sortBy) {
            case 'occurrences':
                worlds.sort((a, b) => b.occurrences - a.occurrences);
                break;
            case 'name':
                worlds.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'maxOccupants':
                worlds.sort((a, b) => b.maxOccupants - a.maxOccupants);
                break;
            case 'avgOccupants':
            default:
                worlds.sort((a, b) => b.avgOccupants - a.avgOccupants);
                break;
        }
    }
}

// Run the aggregator if this script is executed directly
if (require.main === module) {
    // Simple CLI argument parsing
    function parseArgs() {
        const args = process.argv.slice(2);
        const options = {};
        
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            
            if (arg === '--help' || arg === '-h') {
                console.log(`
VRChat World Statistics Aggregator

Usage: node aggregate_stats.js [options]

Options:
  --data-dir <path>        Directory containing daily data files (default: daily-data)
  --output <file>          Output file path (default: aggregated_stats.json)
  --sort <field>           Sort by: avgOccupants, occurrences, maxOccupants, name (default: avgOccupants)
  --min-occurrences <num>  Minimum occurrences to include world (default: 1)
  --top <num>              Number of top worlds to display (default: 10)
  --help, -h               Show this help message

Examples:
  node aggregate_stats.js
  node aggregate_stats.js --sort occurrences --min-occurrences 5
  node aggregate_stats.js --output my_stats.json --top 20
  npm run aggregate
`);
                process.exit(0);
            } else if (arg === '--data-dir' && i + 1 < args.length) {
                options.dataDir = args[++i];
            } else if (arg === '--output' && i + 1 < args.length) {
                options.outputFile = args[++i];
            } else if (arg === '--sort' && i + 1 < args.length) {
                options.sortBy = args[++i];
            } else if (arg === '--min-occurrences' && i + 1 < args.length) {
                options.minOccurrences = parseInt(args[++i]);
            } else if (arg === '--top' && i + 1 < args.length) {
                options.topN = parseInt(args[++i]);
            }
        }
        
        return options;
    }

    const options = parseArgs();
    const aggregator = new WorldStatsAggregator(options);
    aggregator.aggregate().catch(error => {
        console.error('Aggregation failed:', error);
        process.exit(1);
    });
}

module.exports = WorldStatsAggregator;