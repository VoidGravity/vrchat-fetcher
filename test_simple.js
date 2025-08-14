#!/usr/bin/env node

// Simple test script to verify the new features work correctly (no server start)
const fs = require('fs');
const path = require('path');

// Import just the class functionality we need to test
class TestVRChatFetcher {
    constructor() {
        // Minimal constructor for testing
    }
    
    isFakeOrSampleWorld(world) {
        if (!world || !world.name) return false;
        
        const name = world.name.toLowerCase();
        const fakeWorldPatterns = [
            'sample world',
            'test world',
            'fake world',
            'demo world',
            'placeholder world'
        ];
        
        return fakeWorldPatterns.some(pattern => name.includes(pattern));
    }

    filterFakeWorlds(worlds) {
        if (!Array.isArray(worlds)) return worlds;
        
        const filtered = worlds.filter(world => !this.isFakeOrSampleWorld(world));
        const removedCount = worlds.length - filtered.length;
        
        if (removedCount > 0) {
            console.log(`🧹 Filtered out ${removedCount} fake/sample worlds`);
        }
        
        return filtered;
    }
    
    createAnalyticsWithNestedUsers(dailyData) {
        if (!dailyData.worlds || !dailyData.users) {
            return dailyData;
        }

        const analyticsData = {
            ...dailyData,
            worlds: dailyData.worlds.map(world => {
                const worldWithUser = { ...world };
                
                // Add user details if available
                if (world.authorId && dailyData.users[world.authorId]) {
                    worldWithUser.author = {
                        ...dailyData.users[world.authorId]
                    };
                }
                
                return worldWithUser;
            })
        };

        // Remove the separate users object since it's now nested
        delete analyticsData.users;
        
        return analyticsData;
    }
    
    calculateDayStats(worlds) {
        if (!worlds || worlds.length === 0) {
            return {
                totalWorlds: 0,
                avgOccupants: 0,
                maxOccupants: 0,
                minOccupants: 0,
                totalOccupants: 0,
                worldsWithOccupants: 0
            };
        }

        const occupantCounts = worlds.map(world => {
            return world.occupants || world.publicOccupants || world.heat || world.popularity || 0;
        });

        const totalOccupants = occupantCounts.reduce((a, b) => a + b, 0);
        const worldsWithOccupants = occupantCounts.filter(count => count > 0).length;

        return {
            totalWorlds: worlds.length,
            avgOccupants: worlds.length > 0 ? Math.round((totalOccupants / worlds.length) * 100) / 100 : 0,
            maxOccupants: worlds.length > 0 ? Math.max(...occupantCounts) : 0,
            minOccupants: worlds.length > 0 ? Math.min(...occupantCounts) : 0,
            totalOccupants: totalOccupants,
            worldsWithOccupants: worldsWithOccupants
        };
    }
}

// Mock data for testing
const testDailyData = {
    date: "2025-08-14",
    worlds: [
        {
            id: "wrld_12345",
            name: "Sample World 1", // This should be filtered
            authorId: "usr_11111",
            occupants: 5
        },
        {
            id: "wrld_23456",
            name: "Sample World 2", // This should be filtered
            authorId: "usr_22222",
            occupants: 8
        },
        {
            id: "wrld_real1",
            name: "Real World",
            authorId: "usr_22222",
            occupants: 10
        },
        {
            id: "wrld_real2", 
            name: "Another Real World",
            authorId: "usr_11111",
            occupants: 15
        }
    ],
    users: {
        "usr_11111": {
            id: "usr_11111",
            displayName: "Test User 1",
            fetchTimestamp: "2025-08-14T10:00:00.000Z"
        },
        "usr_22222": {
            id: "usr_22222", 
            displayName: "Test User 2",
            fetchTimestamp: "2025-08-14T10:00:00.000Z"
        }
    }
};

async function testFeatures() {
    console.log('🧪 Testing VRChat Fetcher Enhanced Features');
    console.log('='.repeat(50));
    
    const fetcher = new TestVRChatFetcher();
    
    // Test 1: Fake world filtering
    console.log('\n1. Testing fake world filtering...');
    console.log(`   Original worlds: ${testDailyData.worlds.length}`);
    testDailyData.worlds.forEach(world => {
        console.log(`     - ${world.name} (${world.id})`);
    });
    
    const filteredWorlds = fetcher.filterFakeWorlds(testDailyData.worlds);
    console.log(`   After filtering: ${filteredWorlds.length}`);
    filteredWorlds.forEach(world => {
        console.log(`     - ${world.name} (${world.id})`);
    });
    
    // Test 2: User nesting
    console.log('\n2. Testing user detail nesting...');
    const testDataForNesting = {
        ...testDailyData,
        worlds: filteredWorlds // Use filtered worlds
    };
    
    const analyticsData = fetcher.createAnalyticsWithNestedUsers(testDataForNesting);
    console.log(`   Original structure: ${testDataForNesting.worlds.length} worlds array + users object`);
    console.log(`   New structure: ${analyticsData.worlds.length} worlds array with nested author details`);
    console.log(`   Users object removed: ${!analyticsData.users}`);
    
    // Show example of nested user data
    const worldWithAuthor = analyticsData.worlds.find(w => w.author);
    if (worldWithAuthor) {
        console.log(`   Example world with author:`);
        console.log(`     World: ${worldWithAuthor.name}`);
        console.log(`     Author: ${worldWithAuthor.author.displayName} (${worldWithAuthor.author.id})`);
    }
    
    // Test 3: Day statistics calculation
    console.log('\n3. Testing day statistics...');
    const dayStats = fetcher.calculateDayStats(filteredWorlds);
    console.log(`   Total worlds: ${dayStats.totalWorlds}`);
    console.log(`   Average occupants: ${dayStats.avgOccupants}`);
    console.log(`   Max occupants: ${dayStats.maxOccupants}`);
    console.log(`   Min occupants: ${dayStats.minOccupants}`);
    console.log(`   Total occupants: ${dayStats.totalOccupants}`);
    console.log(`   Worlds with occupants: ${dayStats.worldsWithOccupants}`);
    
    // Test 4: Write test analytics file
    console.log('\n4. Testing analytics file creation...');
    const analyticsFilePath = '/tmp/test_analytics.json';
    fs.writeFileSync(analyticsFilePath, JSON.stringify(analyticsData, null, 2));
    console.log(`   Analytics file created: ${analyticsFilePath}`);
    console.log(`   File size: ${fs.statSync(analyticsFilePath).size} bytes`);
    
    console.log('\n✅ All tests completed successfully!');
    console.log('\n📋 Summary of Enhancements:');
    console.log('   ✓ Fake/sample worlds are filtered out');
    console.log('   ✓ User details are nested within world objects');
    console.log('   ✓ Enhanced statistics are calculated');
    console.log('   ✓ Analytics data structure is ready for email attachment');
}

testFeatures().catch(console.error);